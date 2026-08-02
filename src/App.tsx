"use client";

import { FormEvent, Fragment, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import JsBarcode from "jsbarcode";
import { AppSettings, dataService, Department, Job, JobPart, ScanEvent, seedState, StatusDefinition } from "../lib/dataService";
import { cloudDataService } from "../lib/cloudDataService";
import { parseScannerInput } from "../lib/scanner";
import { usePlantFlowAuth } from "./auth";
import { UserAccessPanel } from "./userAccess";
import worthHigginsLogo from "./assets/WHALogo_Horizontal.png";
import whaWhiteLogo from "./assets/WHA_White.png";

type Page = "dashboard" | "create" | "jobs" | "history" | "admin";
type Notice = { kind: "success" | "error" | "duplicate"; title: string; detail: string } | null;
type ReportType = "daily" | "snapshot" | "workload" | "risks";
type SafariFullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type SafariFullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type DepartmentSelection = string[] | null;

const nav: { id: Page; label: string; icon: string }[] = [
  { id: "dashboard", label: "Live Dashboard", icon: "⌂" },
  { id: "create", label: "Create Job", icon: "+" },
  { id: "jobs", label: "Active Jobs", icon: "≡" },
  { id: "history", label: "Job History", icon: "history" },
  { id: "admin", label: "Administration", icon: "⚙" },
];

const statusTone: Record<string, string> = {
  "Ready for Production": "slate", "In Production": "blue", "On Hold": "amber",
  "Waiting for Materials": "orange", Rework: "red", Complete: "green", Canceled: "slate",
};

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `pf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function timeAgo(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

const WORKDAY_MINUTES = 9 * 60;

function businessMinutesSince(value: string, now = new Date()) {
  const start = new Date(value);
  if (Number.isNaN(start.getTime()) || start >= now) return 0;
  let minutes = 0;
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const lastDay = new Date(now);
  lastDay.setHours(0, 0, 0, 0);
  while (cursor <= lastDay) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) {
      const opening = new Date(cursor);
      opening.setHours(8, 0, 0, 0);
      const closing = new Date(cursor);
      closing.setHours(17, 0, 0, 0);
      const intervalStart = Math.max(start.getTime(), opening.getTime());
      const intervalEnd = Math.min(now.getTime(), closing.getTime());
      if (intervalEnd > intervalStart) minutes += Math.floor((intervalEnd - intervalStart) / 60_000);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return minutes;
}

function trackedMinutes(value: string, overtime = false) {
  return overtime
    ? Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000))
    : businessMinutesSince(value);
}

function timestampForTrackedMinutesAgo(minutes: number, overtime = false) {
  const safeMinutes = Math.max(0, Math.floor(minutes));
  if (overtime || !safeMinutes) return new Date(Date.now() - safeMinutes * 60_000).toISOString();
  const cursor = new Date();
  let remaining = safeMinutes;
  const moveToPreviousBusinessClose = () => {
    cursor.setDate(cursor.getDate() - 1);
    while (cursor.getDay() === 0 || cursor.getDay() === 6) cursor.setDate(cursor.getDate() - 1);
    cursor.setHours(17, 0, 0, 0);
  };
  while (remaining > 0) {
    if (cursor.getDay() === 0 || cursor.getDay() === 6) {
      moveToPreviousBusinessClose();
      continue;
    }
    const opening = new Date(cursor);
    opening.setHours(8, 0, 0, 0);
    const closing = new Date(cursor);
    closing.setHours(17, 0, 0, 0);
    if (cursor > closing) cursor.setTime(closing.getTime());
    if (cursor <= opening) {
      moveToPreviousBusinessClose();
      continue;
    }
    const available = Math.floor((cursor.getTime() - opening.getTime()) / 60_000);
    const used = Math.min(remaining, available);
    cursor.setTime(cursor.getTime() - used * 60_000);
    remaining -= used;
    if (remaining > 0) moveToPreviousBusinessClose();
  }
  return cursor.toISOString();
}

function formatTrackedTime(value: string, settings: AppSettings, overtime = false) {
  const minutes = trackedMinutes(value, overtime);
  const suffix = overtime ? " · OT" : "";
  return `${formatTrackedMinutes(minutes, settings)}${suffix}`;
}

function formatTrackedMinutes(minutes: number, settings: AppSettings) {
  if (settings.timeDisplayMode === "hours") {
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  }
  if (!minutes) return "0d";
  const days = Math.max(.1, Math.round(minutes / WORKDAY_MINUTES * 10) / 10);
  return `${days.toFixed(days % 1 ? 1 : 0)}d`;
}

function formatDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function localDateValue(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const localOffset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - localOffset).toISOString().slice(0, 10);
}

function deadlineTone(dueDate: string, enabled: boolean) {
  if (!enabled) return "";
  if (dueDate < localDateValue()) return "deadline-overdue";
  if (dueDate <= localDateValue(2)) return "deadline-soon";
  return "";
}

function jobIsClosed(job: Job, statuses: StatusDefinition[]) {
  const parts = job.parts || [];
  if (parts.length) return parts.every(part => statuses.find(status => status.name === part.status)?.closesJob);
  return Boolean(statuses.find(status => status.name === job.status)?.closesJob);
}

function jobIsComplete(job: Job, statuses: StatusDefinition[]) {
  const completeNames = new Set(statuses.filter(status => status.code === "COMPLETE").map(status => status.name));
  const parts = job.parts || [];
  if (parts.length) return parts.every(part => completeNames.has(part.status));
  return completeNames.has(job.status);
}

function jobIsCanceled(job: Job, statuses: StatusDefinition[]) {
  const canceledNames = new Set(statuses.filter(status => status.code === "CANCELED").map(status => status.name));
  const parts = job.parts || [];
  if (parts.length) return parts.every(part => canceledNames.has(part.status));
  return canceledNames.has(job.status);
}

function withCompletionMetadata(previousState: typeof seedState, nextState: typeof seedState) {
  const previousJobs = new Map(previousState.jobs.map(job => [job.id, job]));
  return {
    ...nextState,
    jobs: nextState.jobs.map(job => {
      const previous = previousJobs.get(job.id);
      const complete = jobIsComplete(job, nextState.statuses);
      const wasComplete = previous ? jobIsComplete(previous, previousState.statuses) : false;
      if (complete) {
        return {
          ...job,
          completedAt: job.completedAt || previous?.completedAt || (wasComplete ? previous?.updatedAt : job.updatedAt),
        };
      }
      if (wasComplete || job.completedAt || job.billingState || job.billingNote || job.billingApprovedAt || job.billingClearedAt) {
        return { ...job, completedAt: undefined, billingState: undefined, billingNote: undefined, billingApprovedAt: undefined, billingClearedAt: undefined };
      }
      return job;
    }),
  };
}

function parentLocation(job: Job, deptName: (id: string) => string) {
  const parts = job.parts || [];
  if (!parts.length) return deptName(job.currentDepartmentId);
  return "Multiple parts";
}

function jobIsInDepartment(job: Job, departmentId: string) {
  const parts = job.parts || [];
  if (departmentId === "__not_started__") {
    return parts.length ? parts.some(part => !part.currentDepartmentId) : !job.currentDepartmentId;
  }
  return parts.length ? parts.some(part => part.currentDepartmentId === departmentId) : job.currentDepartmentId === departmentId;
}

function jobIsInDepartments(job:Job,departmentIds:DepartmentSelection) {
  if (departmentIds===null) return true;
  return departmentIds.some(departmentId=>jobIsInDepartment(job,departmentId));
}

function departmentSelectionLabel(selection:DepartmentSelection,departmentName:(id:string)=>string) {
  if (selection===null) return "All departments";
  if (!selection.length) return "No departments";
  if (selection.length===1) return selection[0]==="__not_started__"?"Not started":departmentName(selection[0]);
  return `${selection.length} departments`;
}

function DepartmentMultiSelect({departments,value,onChange,compact=false}:{departments:Department[];value:DepartmentSelection;onChange:(value:DepartmentSelection)=>void;compact?:boolean}) {
  const [open,setOpen]=useState(false);
  const rootRef=useRef<HTMLDivElement>(null);
  const options=[{id:"__not_started__",name:"Not started"},...departments.filter(department=>department.enabled).sort((a,b)=>a.order-b.order).map(department=>({id:department.id,name:department.name}))];
  const allIds=options.map(option=>option.id);
  const isSelected=(id:string)=>value===null||value.includes(id);
  const toggle=(id:string)=>{
    const current=value===null?allIds:value;
    const next=current.includes(id)?current.filter(item=>item!==id):[...current,id];
    onChange(next.length===allIds.length?null:next);
  };
  useEffect(()=>{
    if(!open)return;
    const close=(event:MouseEvent)=>{if(!rootRef.current?.contains(event.target as Node))setOpen(false)};
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")setOpen(false)};
    document.addEventListener("mousedown",close);
    document.addEventListener("keydown",escape);
    return()=>{document.removeEventListener("mousedown",close);document.removeEventListener("keydown",escape)};
  },[open]);
  const name=(id:string)=>options.find(option=>option.id===id)?.name||id;
  return <div className={`department-multi ${compact?"compact":""} ${open?"open":""}`} ref={rootRef}>
    <button type="button" className="department-multi-trigger" aria-haspopup="true" aria-expanded={open} onClick={()=>setOpen(current=>!current)}><span>{departmentSelectionLabel(value,name)}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>
    {open&&<div className="department-multi-menu"><div className="department-multi-actions"><button type="button" onClick={()=>onChange(null)}>Show all</button><button type="button" onClick={()=>onChange([])}>Clear</button></div><div className="department-multi-options">{options.map(option=><label key={option.id}><input type="checkbox" checked={isSelected(option.id)} onChange={()=>toggle(option.id)}/><span>{option.name}</span></label>)}</div><div className="department-multi-footer"><span>{value===null?"Every department is shown":`${value.length} of ${options.length} selected`}</span><button type="button" onClick={()=>setOpen(false)}>Done</button></div></div>}
  </div>;
}

function parentStatus(job: Job) {
  const parts = job.parts || [];
  if (!parts.length) return job.status;
  return "View parts";
}

function parentUpdatedAt(job: Job) {
  const parts = job.parts || [];
  return parts.length ? [...parts].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0].updatedAt : job.updatedAt;
}

async function downloadExcelBackup(state: typeof seedState) {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PlantFlow Production Tracker";
  workbook.company = "Worth Higgins & Associates";
  workbook.created = new Date();
  workbook.modified = new Date();
  const departmentName = (id: string) => state.departments.find(item=>item.id===id)?.name || "Not started";
  const activeJobs = state.jobs.filter(job=>!jobIsClosed(job,state.statuses));
  const headerFill = "FF155F48";
  const lightFill = "FFF4F7F5";
  const addSheet = (name:string, headers:string[], rows:(string|number|Date)[][], widths:number[], wrapColumns:number[] = []) => {
    const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.addRow(headers);
    if(rows.length){
      sheet.addRows(rows);
      sheet.autoFilter={
        from:{row:1,column:1},
        to:{row:rows.length+1,column:headers.length},
      };
    }
    sheet.columns.forEach((column,index)=>{ column.width=widths[index]||14; });
    const header = sheet.getRow(1);
    header.height = 25;
    header.eachCell(cell=>{
      cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:headerFill}};
      cell.font={bold:true,color:{argb:"FFFFFF"},size:11};
      cell.alignment={vertical:"middle",horizontal:"left"};
      cell.border={bottom:{style:"thin",color:{argb:"B9CBC3"}}};
    });
    for(let rowNumber=2;rowNumber<=sheet.rowCount;rowNumber++){
      const row=sheet.getRow(rowNumber);
      row.height=21;
      row.eachCell((cell,columnNumber)=>{
        if(rowNumber%2===0) cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:lightFill}};
        cell.font={color:{argb:"1D332B"},size:10};
        cell.alignment={vertical:"middle",wrapText:wrapColumns.includes(columnNumber)};
        cell.border={bottom:{style:"hair",color:{argb:"DDE7E2"}}};
      });
    }
    sheet.pageSetup={orientation:"landscape",fitToPage:true,fitToWidth:1,fitToHeight:0,margins:{left:.25,right:.25,top:.4,bottom:.4,header:.2,footer:.2}};
    return sheet;
  };

  const jobsSheet=addSheet("All Jobs",["Job Number","Customer","Description","Current Department","Status","Priority","Due Date","Overtime","Created","Last Updated","Production Route","Notes","Billing State","Billing Note","Completed At","Billing Approved At","Record ID","Department ID","Route Department IDs"],state.jobs.map(job=>[job.jobNumber,job.customer,job.description,departmentName(job.currentDepartmentId),job.status,job.priority,new Date(`${job.dueDate}T12:00:00`),job.overtime?"Yes":"No",new Date(job.createdAt),new Date(job.updatedAt),job.route.map(departmentName).join(" → "),job.notes,job.billingState==="approved"||job.billingApprovedAt?"OK to Bill":job.billingState==="hold"?"Billing Hold":jobIsComplete(job,state.statuses)?"Awaiting Review":"",job.billingNote||"",job.completedAt?new Date(job.completedAt):"",job.billingApprovedAt?new Date(job.billingApprovedAt):"",job.id,job.currentDepartmentId,job.route.join("|")]),[15,24,38,22,22,13,14,12,21,21,46,44,18,42,21,21,38,22,42],[3,11,12,14,19]);
  jobsSheet.getColumn(7).numFmt="mmm d, yyyy";
  jobsSheet.getColumn(9).numFmt="mmm d, yyyy h:mm AM/PM";
  jobsSheet.getColumn(10).numFmt="mmm d, yyyy h:mm AM/PM";
  jobsSheet.getColumn(15).numFmt="mmm d, yyyy h:mm AM/PM";
  jobsSheet.getColumn(16).numFmt="mmm d, yyyy h:mm AM/PM";
  jobsSheet.getColumn(17).hidden=true;
  jobsSheet.getColumn(18).hidden=true;
  jobsSheet.getColumn(19).hidden=true;
  jobsSheet.getRow(1).height=29;
  const partRows=state.jobs.flatMap(job=>(job.parts||[]).map(part=>[job.jobNumber,part.code,part.name,part.description,part.quantity,departmentName(part.currentDepartmentId),part.status,new Date(part.updatedAt),part.id,job.id]));
  const partsSheet=addSheet("Job Parts",["Parent Job","Part Barcode","Part Name","Description","Quantity","Current Department","Status","Last Updated","Part ID","Parent Record ID"],partRows,[16,18,24,36,12,22,22,22,38,38],[3,4]);
  partsSheet.getColumn(8).numFmt="mmm d, yyyy h:mm AM/PM";
  partsSheet.getColumn(9).hidden=true;
  partsSheet.getColumn(10).hidden=true;
  const summary=workbook.addWorksheet("Backup Summary");
  summary.columns=[{width:28},{width:50}];
  summary.mergeCells("A1:B1");
  summary.getCell("A1").value="PlantFlow Emergency Backup";
  summary.getCell("A1").fill={type:"pattern",pattern:"solid",fgColor:{argb:headerFill}};
  summary.getCell("A1").font={bold:true,color:{argb:"FFFFFF"},size:18};
  summary.getCell("A1").alignment={vertical:"middle"};
  summary.getRow(1).height=34;
  [["Generated",new Date().toLocaleString()],["Active jobs",activeJobs.length],["All job records",state.jobs.length],["Scan history records",state.scans.length],["Departments",state.departments.length],["Statuses",state.statuses.length],["Purpose","Complete emergency operational backup. Use the tabs below to filter, search, and review records."]].forEach((row,index)=>{
    const excelRow=summary.addRow(row);
    excelRow.height=index===6?38:23;
    excelRow.getCell(1).font={bold:true,color:{argb:"155F48"}};
    excelRow.getCell(2).alignment={vertical:"middle",wrapText:true};
    if(index%2===0) excelRow.eachCell(cell=>cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:lightFill}});
  });
  summary.views=[{state:"frozen",ySplit:1}];

  const scansSheet=addSheet("Scan History",["Timestamp","Job Number","Department","Previous Department","Event Type","Status Command"],state.scans.map(scan=>[new Date(scan.timestamp),scan.jobNumber,scan.departmentName,departmentName(scan.previousDepartmentId),scan.type,scan.statusName||""]),[23,16,22,22,18,24]);
  scansSheet.getColumn(1).numFmt="mmm d, yyyy h:mm:ss AM/PM";
  addSheet("Departments",["Order","Department","Scanner Prefix","Enabled"],state.departments.map(item=>[item.order,item.name,item.prefix,item.enabled?"Yes":"No"]),[10,28,24,12]);
  addSheet("Statuses",["Order","Status","Barcode Command","Enabled","Closes Job"],state.statuses.map(item=>[item.order,item.name,`STATUS:${item.code}`,item.enabled?"Yes":"No",item.closesJob?"Yes":"No"]),[10,28,30,12,14]);
  addSheet("Settings",["Setting","Value"],[["Due-date row highlighting",state.settings.deadlineHighlighting?"Enabled":"Disabled"],["Time Here display",state.settings.timeDisplayMode==="days"?"Business days":"Business hours"],["Standard business schedule","Monday–Friday, 8:00 AM–5:00 PM"],["Ready for Billing auto-delete",state.settings.billingAutoDeleteApproved30Days?"Enabled — OK to Bill jobs clear after 30 days":"Disabled — retain until manually cleared"]],[30,48]);

  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer);
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
  const link = document.createElement("a");
  link.href=url;
  link.download=`PlantFlow_Emergency_Backup_${localDateValue()}.xlsx`;
  link.style.display="none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(()=>URL.revokeObjectURL(url),10_000);
}

function Code128({ value }: { value: string }) {
  const barcodeRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (barcodeRef.current) JsBarcode(barcodeRef.current, value, { format: "CODE128", width: 2, height: 58, margin: 0, displayValue: true, fontSize: 14 });
  }, [value]);
  return <div className="barcode-wrap"><svg ref={barcodeRef} aria-label={`Code 128 barcode for ${value}`} /></div>;
}

function CalendarDatePicker({ value, onChange, min, name }: { value: string; onChange: (value: string) => void; min?: string; name?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedDate = new Date(`${value}T12:00:00`);
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);
  const toValue = (date: Date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay());
  const days = Array.from({ length: 42 }, (_, index) => { const day = new Date(gridStart); day.setDate(gridStart.getDate()+index); return day; });
  const moveMonth = (amount: number) => setViewMonth(current => new Date(current.getFullYear(), current.getMonth()+amount, 1));
  const displayDate = selectedDate.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  return <div className="calendar-field" ref={rootRef}>
    {name&&<input type="hidden" name={name} value={value}/>} 
    <button type="button" className={`calendar-trigger ${open?"open":""}`} aria-expanded={open} aria-haspopup="dialog" onClick={()=>{setViewMonth(new Date(selectedDate.getFullYear(),selectedDate.getMonth(),1));setOpen(current=>!current)}}><span>{displayDate}</span><b aria-hidden="true">▦</b></button>
    {open&&<div className="calendar-popover" role="dialog" aria-label="Choose production due date">
      <div className="calendar-head"><button type="button" aria-label="Previous month" onClick={()=>moveMonth(-1)}>‹</button><strong>{viewMonth.toLocaleDateString(undefined,{month:"long",year:"numeric"})}</strong><button type="button" aria-label="Next month" onClick={()=>moveMonth(1)}>›</button></div>
      <div className="calendar-weekdays">{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(day=><span key={day}>{day}</span>)}</div>
      <div className="calendar-days">{days.map(day=>{const dayValue=toValue(day);const outside=day.getMonth()!==viewMonth.getMonth();return <button type="button" key={dayValue} disabled={Boolean(min&&dayValue<min)} className={`${outside?"outside ":""}${dayValue===value?"selected ":""}${dayValue===localDateValue()?"today":""}`.trim()} onClick={()=>{onChange(dayValue);setOpen(false)}}>{day.getDate()}</button>})}</div>
    </div>}
  </div>;
}

function OverlayPortal({children,target}:{children:ReactNode;target:HTMLElement|null}) {
  return target ? createPortal(children,target) : children;
}

export default function Home() {
  const { user, profile, logout } = usePlantFlowAuth();
  const canEdit = ["super_admin","admin","standard","manager"].includes(profile.role);
  const isSuperAdmin = profile.role === "super_admin";
  const hasAdministrationAccess = profile.role === "super_admin" || profile.role === "admin" || profile.role === "manager";
  const canChangeSchedule = profile.role !== "standard";
  const [page, setPage] = useState<Page>("dashboard");
  const [state, setState] = useState(seedState);
  const [notice, setNotice] = useState<Notice>(null);
  const [jobNumberInput, setJobNumberInput] = useState("");
  const [labelJobNumber, setLabelJobNumber] = useState("");
  const [jobDueDate, setJobDueDate] = useState(() => localDateValue(3));
  const [createAsSplit, setCreateAsSplit] = useState(false);
  const [createParts, setCreateParts] = useState([{name:"Part A",description:"",quantity:""},{name:"Part B",description:"",quantity:""}]);
  const [query, setQuery] = useState("");
  const [printJob, setPrintJob] = useState<Job | null>(null);
  const [printPart, setPrintPart] = useState<{job:Job;part:JobPart} | null>(null);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [splitJob, setSplitJob] = useState<Job | null>(null);
  const [groupBy, setGroupBy] = useState<"none" | "location" | "customer">("none");
  const [sortBy, setSortBy] = useState<"recent" | "due" | "priority" | "time" | "job" | "customer">("recent");
  const [departmentFilter, setDepartmentFilter] = useState<DepartmentSelection>(null);
  const [jobControlsOpen, setJobControlsOpen] = useState(false);
  const [jobActionsOpen, setJobActionsOpen] = useState(false);
  const [jobsFullscreen, setJobsFullscreen] = useState(false);
  const [pendingStatuses, setPendingStatuses] = useState<Record<string,{statusId:string;expiresAt:number}>>({});
  const [statusPrint, setStatusPrint] = useState<StatusDefinition[] | null>(null);
  const [managementReport, setManagementReport] = useState<ReportType | null>(null);
  const [olderScans, setOlderScans] = useState<ScanEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [viewerPortal] = useState(() => new URLSearchParams(window.location.search).get("view") === "portal");
  const [productionFloorPortal] = useState(() => new URLSearchParams(window.location.search).get("view") === "production");
  const [cloudStatus, setCloudStatus] = useState<"loading" | "ready" | "offline">("loading");
  const [cloudError, setCloudError] = useState("");
  const [migrationRequired, setMigrationRequired] = useState(false);
  const scanBuffer = useRef("");
  const lastKeyAt = useRef(0);
  const titleBeforePrint = useRef("");
  const activeJobsRef = useRef<HTMLElement>(null);
  const cloudReady = useRef(false);
  const pendingCloudState = useRef<typeof state | null>(null);
  const historyPagingStarted = useRef(false);

  useEffect(() => {
    const localState = dataService.load();
    setState(localState);
    setSidebarCollapsed(window.localStorage.getItem("plantflow-sidebar-collapsed") === "true");
    const unsubscribe = cloudDataService.subscribe(remoteState => {
      if (!remoteState) {
        cloudReady.current = false;
        setMigrationRequired(canEdit);
        setCloudStatus("ready");
        return;
      }
      if (pendingCloudState.current && canEdit) {
        const queuedState = pendingCloudState.current;
        pendingCloudState.current = null;
        cloudReady.current = true;
        setCloudStatus("ready");
        setCloudError("");
        void cloudDataService.saveChanges(remoteState, queuedState, user.uid).catch(error => {
          pendingCloudState.current = queuedState;
          cloudReady.current = false;
          setCloudStatus("offline");
          setCloudError(error instanceof Error ? error.message : "Queued changes could not be synchronized.");
        });
        return;
      }
      cloudReady.current = true;
      setMigrationRequired(false);
      setCloudStatus("ready");
      setCloudError("");
      setState(remoteState);
      dataService.save(remoteState);
      if (!historyPagingStarted.current) setHistoryHasMore(remoteState.scans.length >= 300);
      if (canEdit) void cloudDataService.ensurePublicState(remoteState).catch(error => {
        setCloudError(error instanceof Error ? error.message : "The public viewer could not be initialized.");
      });
    }, error => {
      cloudReady.current = false;
      setCloudStatus("offline");
      setCloudError(error.message || "The shared database is temporarily unavailable.");
    });
    return unsubscribe;
  }, [canEdit, user.uid]);
  useEffect(() => {
    const finishPrinting = () => {
      document.body.classList.remove("printing-label");
      document.body.classList.remove("printing-statuses");
      document.body.classList.remove("printing-report");
      if (titleBeforePrint.current) {
        document.title = titleBeforePrint.current;
        titleBeforePrint.current = "";
      }
    };
    window.addEventListener("afterprint", finishPrinting);
    return () => window.removeEventListener("afterprint", finishPrinting);
  }, []);
  useEffect(() => {
    const safariDocument = document as SafariFullscreenDocument;
    const syncFullscreenState = () => setJobsFullscreen((document.fullscreenElement || safariDocument.webkitFullscreenElement) === activeJobsRef.current);
    document.addEventListener("fullscreenchange", syncFullscreenState);
    document.addEventListener("webkitfullscreenchange", syncFullscreenState);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      document.removeEventListener("webkitfullscreenchange", syncFullscreenState);
    };
  }, []);
  const persist = useCallback((next: typeof state) => {
    const normalized = withCompletionMetadata(state, next);
    setState(normalized);
    dataService.save(normalized);
    if (canEdit && cloudReady.current) {
      void cloudDataService.saveChanges(state, normalized, user.uid).catch(error => {
        pendingCloudState.current = normalized;
        cloudReady.current = false;
        setCloudStatus("offline");
        setCloudError(error instanceof Error ? error.message : "The shared update could not be saved.");
      });
    } else if (canEdit) {
      pendingCloudState.current = normalized;
    }
  }, [canEdit, state, user.uid]);

  const historyScans = useMemo(() => {
    const combined = new Map<string, ScanEvent>();
    [...state.scans, ...olderScans].forEach(scan => combined.set(scan.id, scan));
    return [...combined.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [state.scans, olderScans]);

  const loadOlderHistory = async () => {
    const oldest = historyScans.at(-1);
    if (!oldest || historyLoading) return;
    historyPagingStarted.current = true;
    setHistoryLoading(true);
    try {
      const page = await cloudDataService.loadOlderScans(oldest.timestamp);
      setOlderScans(current => {
        const combined = new Map(current.map(scan => [scan.id, scan]));
        page.scans.forEach(scan => combined.set(scan.id, scan));
        return [...combined.values()];
      });
      setHistoryHasMore(page.hasMore);
    } catch (error) {
      setNotice({ kind: "error", title: "Older history could not be loaded", detail: error instanceof Error ? error.message : "Try again when the cloud connection is available." });
    } finally {
      setHistoryLoading(false);
    }
  };

  const initializeSharedData = async (source: "local" | "sample") => {
    const next = source === "local" ? dataService.load() : structuredClone(seedState);
    try {
      await cloudDataService.saveInitial(next, user.uid);
      dataService.save(next);
      setState(next);
      cloudReady.current = true;
      setMigrationRequired(false);
      setCloudStatus("ready");
      setNotice({kind:"success",title:"Shared PlantFlow data created",detail:source === "local" ? "This device’s jobs are now the shared starting point." : "A fresh shared sample workspace is ready."});
    } catch (error) {
      setCloudStatus("offline");
      setCloudError(error instanceof Error ? error.message : "PlantFlow could not create the shared workspace.");
    }
  };

  const toggleActiveJobsFullscreen = async () => {
    try {
      const safariDocument = document as SafariFullscreenDocument;
      const target = activeJobsRef.current as SafariFullscreenElement | null;
      const fullscreenElement = document.fullscreenElement || safariDocument.webkitFullscreenElement;
      if (fullscreenElement === target) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else await safariDocument.webkitExitFullscreen?.();
      } else if (target) {
        if (target.requestFullscreen) await target.requestFullscreen();
        else await target.webkitRequestFullscreen?.();
      }
    } catch {
      setNotice({ kind: "error", title: "Full screen could not open", detail: "Your browser blocked full screen. Try the button again or check the browser’s site permissions." });
    }
  };

  const printBarcode = () => {
    document.body.classList.add("printing-label");
    window.setTimeout(() => window.print(), 50);
  };

  const printStatusBarcodes = () => {
    document.body.classList.add("printing-statuses");
    window.setTimeout(() => window.print(), 50);
  };

  const printManagementReport = async () => {
    const reportFileNames: Record<ReportType, string> = { daily: "Daily_Production_Brief", snapshot: "Executive_Snapshot", workload: "Department_Workload", risks: "Risks_and_Exceptions" };
    titleBeforePrint.current = document.title;
    document.title = `PlantFlow_${reportFileNames[managementReport || "daily"]}_${localDateValue()}`;
    document.body.classList.add("printing-report");
    const reportImages = Array.from(document.querySelectorAll<HTMLImageElement>(".management-report img"));
    await Promise.all(reportImages.map(image => image.complete ? Promise.resolve() : new Promise<void>(resolve => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => resolve(), { once: true });
    })));
    await document.fonts?.ready;
    window.setTimeout(() => window.print(), 100);
  };

  const openCreatedJobLabel = () => {
    const savedJob = state.jobs.find(job => job.jobNumber === labelJobNumber);
    if (savedJob) setPrintJob(savedJob);
  };

  const processScan = useCallback((raw: string) => {
    const standaloneCommand = raw.trim().toUpperCase();
    if (standaloneCommand.startsWith("STATUS:")) {
      const code = standaloneCommand.slice(7).trim();
      const status = state.statuses.find(item => item.enabled && item.code === code);
      if (!status) { setNotice({ kind: "error", title: "Unknown status barcode", detail: `${code || "This command"} is not an enabled status.` }); return; }
      const expiresAt = Date.now() + 15000;
      setPendingStatuses(current => ({ ...current, __global__: { statusId: status.id, expiresAt } }));
      setNotice({ kind: "duplicate", title: `${status.name} selected`, detail: "Now scan one job within 15 seconds. Its department scanner will identify the location." });
      window.setTimeout(() => setPendingStatuses(current => current.__global__?.expiresAt === expiresAt ? Object.fromEntries(Object.entries(current).filter(([key])=>key!=="__global__")) : current), 15050);
      return;
    }
    const parsed = parseScannerInput(raw);
    if (!parsed.ok) { setNotice({ kind: "error", title: "Scan not recognized", detail: parsed.error }); return; }
    const department = state.departments.find(d => d.enabled && d.prefix.toUpperCase() === parsed.prefix);
    if (!department) { setNotice({ kind: "error", title: "Unknown scanner", detail: `No active department uses ${parsed.prefix}|` }); return; }
    if (parsed.jobNumber.startsWith("STATUS:")) {
      const code = parsed.jobNumber.slice(7);
      const status = state.statuses.find(item => item.enabled && item.code === code);
      if (!status) { setNotice({ kind: "error", title: "Unknown status barcode", detail: `${code} is not an enabled status command.` }); return; }
      const expiresAt = Date.now() + 15000;
      setPendingStatuses(current => ({...current,[department.id]:{statusId:status.id,expiresAt}}));
      setNotice({ kind: "duplicate", title: `${status.name} selected for ${department.name}`, detail: "Scan one job within 15 seconds. The command clears after that job." });
      window.setTimeout(() => setPendingStatuses(current => current[department.id]?.expiresAt === expiresAt ? Object.fromEntries(Object.entries(current).filter(([key])=>key!==department.id)) : current),15050);
      return;
    }
    const directJob = state.jobs.find(j => j.jobNumber.toUpperCase() === parsed.jobNumber);
    const partMatch = state.jobs.flatMap(job => (job.parts || []).map(part => ({job,part}))).find(item => item.part.code.toUpperCase() === parsed.jobNumber);
    const job = directJob || partMatch?.job;
    const part = partMatch?.part;
    if (!job) { setNotice({ kind: "error", title: "Job not found", detail: `No active job or job part matches ${parsed.jobNumber}.` }); return; }
    if (directJob?.parts?.length) { setNotice({ kind: "error", title: `Job ${job.jobNumber} is split into parts`, detail: "Scan the barcode attached to the specific part instead of the original parent-job barcode." }); return; }
    const currentStatus = state.statuses.find(item => item.name === (part?.status || job.status));
    if (currentStatus?.closesJob) { setNotice({ kind: "error", title: `Job is ${job.status.toLowerCase()}`, detail: "Reopen the job before scanning it again." }); return; }
    const pending = pendingStatuses[department.id] || pendingStatuses.__global__;
    const commandedStatus = pending && pending.expiresAt > Date.now() ? state.statuses.find(item=>item.id===pending.statusId&&item.enabled) : undefined;
    const normalStatus = state.statuses.find(item=>item.code==="IN_PRODUCTION") || state.statuses.find(item=>item.enabled&&!item.closesJob);
    if (pending) setPendingStatuses(current => Object.fromEntries(Object.entries(current).filter(([key])=>key!==department.id&&key!=="__global__")));
    const previous = state.scans[0];
    const trackedCode = part?.code || job.jobNumber;
    if (!commandedStatus && previous?.jobNumber === trackedCode && previous.departmentId === department.id && Date.now() - new Date(previous.timestamp).getTime() < 30000) {
      setNotice({ kind: "duplicate", title: "Scan already received", detail: `${trackedCode} is already in ${department.name}.` }); return;
    }
    const now = new Date().toISOString();
    const routeIndex = job.route.indexOf(department.id);
    const previousDepartmentId = part?.currentDepartmentId || job.currentDepartmentId;
    const currentIndex = job.route.indexOf(previousDepartmentId);
    const event: ScanEvent = { id: makeId(), jobNumber: trackedCode, departmentId: department.id, departmentName: department.name, previousDepartmentId, timestamp: now, type: commandedStatus ? "Status command" : routeIndex === currentIndex + 1 || currentIndex === -1 ? "Normal" : "Route exception", statusName: commandedStatus?.name, partId: part?.id, partCode: part?.code, partName: part?.name };
    const nextStatus = commandedStatus?.name || normalStatus?.name || "In Production";
    const jobs = state.jobs.map(j => {
      if (j.id !== job.id) return j;
      if (!part) return { ...j, currentDepartmentId: department.id, status: nextStatus, updatedAt: now };
      return { ...j, updatedAt: now, parts: (j.parts || []).map(item => item.id === part.id ? { ...item, currentDepartmentId: department.id, status: nextStatus, updatedAt: now } : item) };
    });
    persist({ ...state, jobs, scans: [event, ...state.scans] });
    setNotice({ kind: "success", title: commandedStatus ? `${trackedCode} changed to ${commandedStatus.name}` : `${trackedCode} moved to ${department.name}`, detail: `${part ? `${part.name} · ` : ""}${department.name} · ${job.customer} · ${new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` });
  }, [state, persist, pendingStatuses]);

  useEffect(() => {
    if (viewerPortal || !canEdit) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editable = target?.matches("input, textarea, select, [contenteditable='true']");
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey || editable) {
        scanBuffer.current = "";
        return;
      }
      const now = performance.now();
      if (now - lastKeyAt.current > 90) scanBuffer.current = "";
      lastKeyAt.current = now;
      if (event.key === "Enter") {
        const completedScan = scanBuffer.current;
        scanBuffer.current = "";
        if ((completedScan.includes("|") || completedScan.toUpperCase().startsWith("STATUS:")) && completedScan.length >= 4) {
          event.preventDefault();
          processScan(completedScan);
        }
        return;
      }
      if (event.key.length === 1) scanBuffer.current += event.key;
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [processScan, viewerPortal, canEdit]);

  const departments = state.departments;
  const statuses = state.statuses;
  const deptName = (id: string) => departments.find(d => d.id === id)?.name || "Not started";
  const activeJobs = state.jobs.filter(job => !jobIsClosed(job,statuses));
  const filteredJobs = activeJobs.filter(j => jobIsInDepartments(j,departmentFilter) && `${j.jobNumber} ${j.customer} ${j.description}`.toLowerCase().includes(query.toLowerCase()));
  const organizedJobs = useMemo(() => {
    const priorityRank = { Critical: 0, Rush: 1, Standard: 2 };
    return [...filteredJobs].sort((a,b) => {
      if (sortBy === "due") return a.dueDate.localeCompare(b.dueDate);
      if (sortBy === "priority") return priorityRank[a.priority] - priorityRank[b.priority] || a.dueDate.localeCompare(b.dueDate);
      if (sortBy === "time") return new Date(parentUpdatedAt(a)).getTime() - new Date(parentUpdatedAt(b)).getTime();
      if (sortBy === "job") return a.jobNumber.localeCompare(b.jobNumber, undefined, { numeric: true });
      if (sortBy === "customer") return a.customer.localeCompare(b.customer);
      return new Date(parentUpdatedAt(b)).getTime() - new Date(parentUpdatedAt(a)).getTime();
    });
  }, [filteredJobs, sortBy]);
  const jobGroups = useMemo(() => {
    if (groupBy === "none") return [{ key: "all", label: departmentFilter===null?"All active jobs":`${departmentSelectionLabel(departmentFilter,deptName)} jobs`, jobs: organizedJobs }];
    const grouped = new Map<string, Job[]>();
    organizedJobs.forEach(job => {
      const partLocations = [...new Set((job.parts || []).map(part=>part.currentDepartmentId))];
      const key = groupBy === "location" ? (partLocations.length > 1 ? "multiple-locations" : (partLocations[0] || job.currentDepartmentId || "not-started")) : job.customer;
      grouped.set(key, [...(grouped.get(key) || []), job]);
    });
    const groups=[...grouped.entries()].map(([key,jobs]) => ({ key, label: groupBy === "location" ? (key === "multiple-locations" ? "Multiple locations" : deptName(key === "not-started" ? "" : key)) : key, jobs }));
    if (groups.length) return groups;
    return [{key:"empty",label:departmentFilter===null?"Active jobs":`${departmentSelectionLabel(departmentFilter,deptName)} jobs`,jobs:[]}];
  }, [groupBy, organizedJobs, departments, departmentFilter]);
  const today = new Date().toISOString().slice(0,10);

  const approveForBilling = (jobIds: string[]) => {
    if (!jobIds.length) return;
    const approvedAt = new Date().toISOString();
    persist({ ...state, jobs: state.jobs.map(job => jobIds.includes(job.id) && jobIsComplete(job, statuses) ? { ...job, billingState: "approved" as const, billingApprovedAt: approvedAt } : job) });
    setNotice({ kind: "success", title: `${jobIds.length} ${jobIds.length === 1 ? "job" : "jobs"} approved for billing`, detail: "The 30-day retention period begins when a job is marked OK to Bill." });
  };

  const clearFromBilling = (jobIds: string[]) => {
    const removable = new Set(state.jobs.filter(job => jobIds.includes(job.id) && jobIsComplete(job, statuses) && (job.billingState === "approved" || job.billingApprovedAt)).map(job => job.id));
    if (!removable.size) return;
    persist({ ...state, jobs: state.jobs.filter(job => !removable.has(job.id)) });
    setNotice({ kind: "success", title: `${removable.size} billed ${removable.size === 1 ? "job was" : "jobs were"} cleared`, detail: "The closed job records were removed. Their permanent movement events remain in Job History." });
  };

  const deleteJobPermanently = async (job: Job) => {
    try {
      await cloudDataService.deleteJobPermanently(job);
      const identifiers = new Set([job.jobNumber, ...(job.parts || []).map(part => part.code)]);
      const next = { ...state, jobs: state.jobs.filter(item => item.id !== job.id), scans: state.scans.filter(scan => !identifiers.has(scan.jobNumber)) };
      setState(next);
      dataService.save(next);
      setOlderScans(current => current.filter(scan => !identifiers.has(scan.jobNumber)));
      setSelectedJob(null);
      setNotice({ kind: "success", title: `Job ${job.jobNumber} permanently deleted`, detail: "The job, its parts, and all movement history were removed. This job number can now be used again." });
    } catch (error) {
      setNotice({ kind: "error", title: "Job could not be deleted", detail: error instanceof Error ? error.message : "The cloud deletion did not complete." });
    }
  };

  const clearAllJobData = async () => {
    try {
      await cloudDataService.clearAllJobData();
      const next = { ...state, jobs: [], scans: [] };
      setState(next);
      dataService.save(next);
      setOlderScans([]);
      setHistoryHasMore(false);
      setSelectedJob(null);
      setNotice({ kind: "success", title: "PlantFlow job data reset", detail: "All jobs and movement history were removed. Departments, statuses, settings, and user access were preserved." });
    } catch (error) {
      setNotice({ kind: "error", title: "Job reset did not complete", detail: error instanceof Error ? error.message : "The cloud deletion did not complete." });
    }
  };

  const updateBillingDetails = (jobId: string, updates: Pick<Job,"billingState"|"billingNote">) => {
    const now = new Date().toISOString();
    persist({
      ...state,
      jobs: state.jobs.map(job => {
        if (job.id !== jobId || !jobIsComplete(job, statuses)) return job;
        const billingState = updates.billingState || "awaiting";
        return {
          ...job,
          billingState,
          billingNote: updates.billingNote?.trim() || "",
          billingApprovedAt: billingState === "approved" ? (job.billingApprovedAt || now) : undefined,
        };
      }),
    });
  };

  useEffect(() => {
    if (!hasAdministrationAccess || cloudStatus !== "ready" || !state.settings.billingAutoDeleteApproved30Days) return;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const expired = state.jobs.filter(job => jobIsComplete(job, state.statuses) && (job.billingState === "approved" || Boolean(job.billingApprovedAt)) && Boolean(job.billingApprovedAt) && new Date(job.billingApprovedAt!).getTime() < cutoff);
    if (expired.length) persist({ ...state, jobs: state.jobs.filter(job => !expired.some(item => item.id === job.id)) });
  }, [cloudStatus, hasAdministrationAccess, persist, state]);

  const saveStatuses = (nextStatuses: StatusDefinition[]) => {
    const renameMap = new Map(statuses.map(oldStatus => [oldStatus.name,nextStatuses.find(item=>item.id===oldStatus.id)?.name||oldStatus.name]));
    persist({...state,statuses:nextStatuses,jobs:state.jobs.map(job=>({...job,status:renameMap.get(job.status)||job.status,parts:job.parts?.map(part=>({...part,status:renameMap.get(part.status)||part.status}))}))});
    setNotice({kind:"success",title:"Statuses updated",detail:"Status names, commands, colors, and availability were saved."});
  };

  const saveJobOverride = (original: Job, updated: Job, minutesHere: number, allowScheduleOverride=false) => {
    if (state.jobs.some(job => job.id !== original.id && job.jobNumber === updated.jobNumber)) {
      setNotice({ kind: "error", title: "Duplicate job number", detail: `${updated.jobNumber} is already being used.` });
      return;
    }
    const locationChanged = updated.currentDepartmentId !== original.currentDepartmentId;
    const scheduleAllowed=canChangeSchedule||allowScheduleOverride;
    const adjustedUpdatedAt = scheduleAllowed ? timestampForTrackedMinutesAgo(minutesHere,Boolean(updated.overtime)) : locationChanged ? new Date().toISOString() : original.updatedAt;
    const saved = { ...updated, dueDate: scheduleAllowed ? updated.dueDate : original.dueDate, updatedAt: adjustedUpdatedAt };
    let scans = state.scans.map(scan => scan.jobNumber === original.jobNumber ? { ...scan, jobNumber: saved.jobNumber } : scan);
    if (saved.currentDepartmentId !== original.currentDepartmentId) {
      const department = departments.find(item => item.id === saved.currentDepartmentId);
      scans = [{ id: makeId(), jobNumber: saved.jobNumber, departmentId: saved.currentDepartmentId, departmentName: department?.name || "Not started", previousDepartmentId: original.currentDepartmentId, timestamp: adjustedUpdatedAt, type: "Manual" as const }, ...scans];
    }
    persist({ ...state, jobs: state.jobs.map(job => job.id === original.id ? saved : job), scans });
    setSelectedJob(null);
    setNotice({ kind: "success", title: `Job ${saved.jobNumber} updated`, detail: "Manual changes were saved and the job record was refreshed." });
  };

  const updateJobInline = (job: Job, field: "location" | "status" | "dueDate" | "priority" | "notes", value: string, allowScheduleOverride=false) => {
    if (field === "dueDate" && !canChangeSchedule && !allowScheduleOverride) return;
    if ((field === "location" && value === job.currentDepartmentId) || (field === "status" && value === job.status) || (field === "dueDate" && value === job.dueDate) || (field === "priority" && value === job.priority) || (field === "notes" && value === job.notes)) return;
    const now = new Date().toISOString();
    const departmentId = field === "location" ? value : job.currentDepartmentId;
    const departmentName = deptName(departmentId);
    const statusName = field === "status" ? value : undefined;
    const updatedJob: Job = {
      ...job,
      currentDepartmentId: departmentId,
      status: statusName || job.status,
      dueDate: field === "dueDate" ? value : job.dueDate,
      priority: field === "priority" ? value as Job["priority"] : job.priority,
      notes: field === "notes" ? value : job.notes,
      updatedAt: field === "location" ? now : job.updatedAt,
    };
    if (field === "dueDate" || field === "priority" || field === "notes") {
      persist({ ...state, jobs: state.jobs.map(item => item.id === job.id ? updatedJob : item) });
      setNotice({ kind: "success", title: `Job ${job.jobNumber} updated`, detail: field === "dueDate" ? `Due date changed to ${formatDate(value)}.` : field === "priority" ? `Priority changed to ${value}.` : "Production note saved." });
      return;
    }
    const event: ScanEvent = {
      id: makeId(),
      jobNumber: job.jobNumber,
      departmentId,
      departmentName,
      previousDepartmentId: job.currentDepartmentId,
      timestamp: now,
      type: "Manual",
      statusName,
    };
    persist({ ...state, jobs: state.jobs.map(item => item.id === job.id ? updatedJob : item), scans: [event, ...state.scans] });
    setNotice({
      kind: "success",
      title: `Job ${job.jobNumber} updated`,
      detail: field === "location" ? `Location changed to ${departmentName}.` : `Status changed to ${value}.`,
    });
  };

  const updatePartInline = (job: Job, part: JobPart, field: "location" | "status", value: string) => {
    if ((field === "location" && value === part.currentDepartmentId) || (field === "status" && value === part.status)) return;
    const now = new Date().toISOString();
    const departmentId = field === "location" ? value : part.currentDepartmentId;
    const statusName = field === "status" ? value : undefined;
    const updatedPart = { ...part, currentDepartmentId: departmentId, status: statusName || part.status, updatedAt: field === "location" ? now : part.updatedAt };
    const event: ScanEvent = { id: makeId(), jobNumber: part.code, departmentId, departmentName: deptName(departmentId), previousDepartmentId: part.currentDepartmentId, timestamp: now, type: "Manual", statusName, partId: part.id, partCode: part.code, partName: part.name };
    persist({ ...state, jobs: state.jobs.map(item => item.id === job.id ? { ...item, updatedAt: now, parts: (item.parts || []).map(candidate => candidate.id === part.id ? updatedPart : candidate) } : item), scans: [event, ...state.scans] });
    setNotice({ kind: "success", title: `${part.code} updated`, detail: field === "location" ? `${part.name} moved to ${deptName(departmentId)}.` : `${part.name} changed to ${value}.` });
  };

  const saveJobSplit = (job: Job, parts: Array<Pick<JobPart,"name"|"description"|"quantity">>) => {
    const now = new Date().toISOString();
    const createdParts: JobPart[] = parts.map((part,index) => ({ id: makeId(), code: `${job.jobNumber}-${String.fromCharCode(65+index)}`, name: part.name.trim() || `Part ${String.fromCharCode(65+index)}`, description: part.description.trim(), quantity: part.quantity.trim(), currentDepartmentId: job.currentDepartmentId, status: job.status, updatedAt: now }));
    const existingCodes = new Set(state.jobs.flatMap(item => [item.jobNumber.toUpperCase(),...(item.parts||[]).map(part=>part.code.toUpperCase())]));
    const conflict = createdParts.find(part => existingCodes.has(part.code.toUpperCase()));
    if (conflict) { setNotice({ kind: "error", title: "Part barcode already exists", detail: `${conflict.code} is already assigned to another job or part.` }); return; }
    persist({ ...state, jobs: state.jobs.map(item => item.id === job.id ? { ...item, parts: createdParts, updatedAt: now } : item) });
    setSplitJob(null);
    setJobActionsOpen(true);
    setNotice({ kind: "success", title: `Job ${job.jobNumber} split into ${createdParts.length} parts`, detail: "Expand the job to review the parts and print each part label before moving them independently." });
  };

  const createJob = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const jobNumber = String(form.get("jobNumber") || "").trim();
    if (state.jobs.some(j => j.jobNumber === jobNumber)) { setNotice({ kind: "error", title: "Duplicate job number", detail: `${jobNumber} already exists.` }); return; }
    const now = new Date().toISOString();
    const route = departments.filter(d => d.enabled && form.get(`route-${d.id}`)).map(d => d.id);
    const initialDepartmentId=String(form.get("initialDepartmentId")||"");
    const initialStatus=initialDepartmentId
      ? statuses.find(item=>item.code==="IN_PRODUCTION")?.name||"In Production"
      : statuses.find(item=>item.code==="READY")?.name||"Ready for Production";
    const parts: JobPart[]|undefined=createAsSplit?createParts.map((part,index)=>({id:makeId(),code:`${jobNumber}-${String.fromCharCode(65+index)}`,name:part.name.trim()||`Part ${String.fromCharCode(65+index)}`,description:part.description.trim(),quantity:part.quantity.trim(),currentDepartmentId:initialDepartmentId,status:initialStatus,updatedAt:now})):undefined;
    const existingCodes=new Set(state.jobs.flatMap(item=>[item.jobNumber.toUpperCase(),...(item.parts||[]).map(part=>part.code.toUpperCase())]));
    const conflict=parts?.find(part=>existingCodes.has(part.code.toUpperCase()));
    if(conflict){setNotice({kind:"error",title:"Part barcode already exists",detail:`${conflict.code} is already assigned to another job or part.`});return;}
    const job: Job = { id: makeId(), jobNumber, customer: String(form.get("customer")), description: String(form.get("description")), dueDate: String(form.get("dueDate")), priority: String(form.get("priority")) as Job["priority"], status: initialStatus, currentDepartmentId: initialDepartmentId, route, notes: String(form.get("notes")), createdAt: now, updatedAt: now, overtime: form.get("overtime") === "on", parts };
    persist({ ...state, jobs: [job, ...state.jobs] });
    setLabelJobNumber("");
    setJobNumberInput("");
    setJobDueDate(localDateValue(3));
    setCreateAsSplit(false);
    setCreateParts([{name:"Part A",description:"",quantity:""},{name:"Part B",description:"",quantity:""}]);
    formElement.reset();
    setNotice({ kind: "success", title: `Job ${jobNumber} created${parts?.length?` with ${parts.length} parts`:""}`, detail: parts?.length?"Open the job in Active Jobs to expand it and print each part label.":"The form is ready for the next job. Its barcode can be printed from Active Jobs or Job History." });
  };

  const toggleSidebar = () => setSidebarCollapsed(current => {
    const next = !current;
    window.localStorage.setItem("plantflow-sidebar-collapsed", String(next));
    return next;
  });

  if (cloudStatus === "loading") return <div className="auth-screen"><div className="auth-loading"><span className="auth-spinner"/><b>Loading shared production data…</b><small>Connecting to PlantFlow Cloud</small></div></div>;

  if (productionFloorPortal && canEdit) return <><ProductionFloorPortal state={state} notice={notice} onDismissNotice={()=>setNotice(null)} onReview={setSelectedJob} onPrint={setPrintJob} onPrintPart={(job,part)=>setPrintPart({job,part})} onSplit={setSplitJob} onUpdateJob={(job,field,value)=>updateJobInline(job,field,value,true)} onUpdatePart={updatePartInline}/><div className="production-scanner-status"><i/><span>Scanner ready</span></div><button className="viewer-signout" type="button" onClick={()=>void logout()}>Sign out</button>{printJob&&<div className="reprint-overlay" role="dialog" aria-modal="true" aria-label={`Reprint barcode for job ${printJob.jobNumber}`}><div className="reprint-modal"><div className="reprint-head"><div><p className="eyebrow">BARCODE REPRINT</p><h2>Job {printJob.jobNumber}</h2></div><button aria-label="Close barcode reprint" onClick={()=>setPrintJob(null)}>×</button></div><div className="reprint-sheet"><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><small>PRODUCTION JOB</small><strong>{printJob.jobNumber}</strong><Code128 value={printJob.jobNumber}/><div className="reprint-details"><b>{printJob.customer}</b><span>{printJob.description}</span><span>Due {formatDate(printJob.dueDate)}</span></div></div><div className="reprint-actions"><button className="secondary" onClick={()=>setPrintJob(null)}>Cancel</button><button className="primary" onClick={printBarcode}>Print Barcode Label</button></div></div></div>}{printPart&&<div className="reprint-overlay" role="dialog" aria-modal="true" aria-label={`Reprint barcode for ${printPart.part.code}`}><div className="reprint-modal"><div className="reprint-head"><div><p className="eyebrow">PART BARCODE</p><h2>{printPart.part.code}</h2></div><button aria-label="Close part barcode reprint" onClick={()=>setPrintPart(null)}>×</button></div><div className="reprint-sheet part-label-sheet"><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><small>PRODUCTION JOB PART</small><strong>{printPart.part.code}</strong><Code128 value={printPart.part.code}/><div className="reprint-details"><b>{printPart.part.name}</b><span>{printPart.part.description||printPart.job.description}</span>{printPart.part.quantity&&<span>Quantity: {printPart.part.quantity}</span>}<span>Parent Job: {printPart.job.jobNumber}</span></div></div><div className="reprint-actions"><button className="secondary" onClick={()=>setPrintPart(null)}>Cancel</button><button className="primary" onClick={printBarcode}>Print Part Label</button></div></div></div>}{selectedJob&&<JobEditor key={selectedJob.id} job={selectedJob} departments={departments} statuses={statuses} canChangeSchedule onClose={()=>setSelectedJob(null)} onSave={(original,updated,minutes)=>saveJobOverride(original,updated,minutes,true)} onPrint={()=>{setSelectedJob(null);setPrintJob(selectedJob)}}/>}{splitJob&&<SplitJobDialog job={splitJob} onClose={()=>setSplitJob(null)} onSave={parts=>saveJobSplit(splitJob,parts)}/>}</>;
  if (viewerPortal || profile.role === "viewer") return <><ReadOnlyPortal state={state}/><button className="viewer-signout" type="button" onClick={()=>void logout()}>Sign out</button></>;

  const availableNav = hasAdministrationAccess ? nav : nav.filter(item => item.id !== "admin");

  return <div className={`app-shell ${sidebarCollapsed?"sidebar-collapsed":""}`}>
    <aside className="sidebar">
      <button className="sidebar-toggle" type="button" onClick={toggleSidebar} aria-label={sidebarCollapsed?"Expand navigation":"Collapse navigation"} title={sidebarCollapsed?"Expand menu":"Collapse menu"}>{sidebarCollapsed?"›":"‹"}</button>
      <div className="brand company-brand"><img className="full-brand-logo" src={worthHigginsLogo} alt="Worth Higgins & Associates" /><img className="compact-brand-logo" src={whaWhiteLogo} alt="WHA"/><div className="product-name"><strong>PlantFlow</strong><small>Production tracking</small></div></div>
      <nav>{availableNav.map(item => <button key={item.id} className={page===item.id?"active":""} onClick={()=>setPage(item.id)} title={sidebarCollapsed?item.label:undefined} aria-label={item.label}><span>{item.icon==="history"?<svg className="nav-history-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4.8 6.4A6.5 6.5 0 1 1 3.5 10"/><path d="M2.7 5.3h3.6v3.6M10 6.6v3.8l2.6 1.5"/></svg>:item.icon}</span><b>{item.label}</b></button>)}</nav>
      <div className="system-card"><span className={`live-dot ${cloudStatus==="offline"?"offline":""}`}/><div><strong>{cloudStatus==="offline"?"Cloud connection interrupted":"PlantFlow Cloud connected"}</strong><small>{cloudStatus==="offline"?"Changes remain on this device":"Scanner listener active"}</small></div></div>
    </aside>
    <main>
      <header><div><p className="eyebrow">SHOP FLOOR CONTROL</p><h1>{nav.find(n=>n.id===page)?.label}</h1></div><div className="header-actions"><div className="user-chip"><b>{profile.displayName || profile.email}</b><span>{profile.role}</span></div><span className="date-chip">{new Date().toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"})}</span><button type="button" className="primary small" onClick={()=>setPage("create")}>+ New job</button><button type="button" className="signout-button" onClick={()=>void logout()}>Sign out</button></div></header>
      {cloudStatus === "offline" && <div className="cloud-warning"><b>Cloud connection interrupted</b><span>PlantFlow is showing the last data saved on this device. New changes are queued and will synchronize when the connection returns.</span>{cloudError&&<small>{cloudError}</small>}</div>}
      {notice && <div className={`notice ${notice.kind}`}><span>{notice.kind==="success"?"✓":notice.kind==="duplicate"?"↺":"!"}</span><div><strong>{notice.title}</strong><small>{notice.detail}</small></div><button onClick={()=>setNotice(null)}>×</button></div>}

      {page === "dashboard" && <section>
        <div className="metrics">
          <Metric label="Active jobs" value={activeJobs.length} sub="Across production" />
          <Metric label="Due today" value={activeJobs.filter(j=>j.dueDate===today).length} sub="Needs attention" tone="amber" />
          <Metric label="Rush / critical" value={activeJobs.filter(j=>j.priority!=="Standard").length} sub="Priority work" tone="red" />
          <Metric label="Completed today" value={state.jobs.filter(j=>j.status==="Complete"&&j.updatedAt.slice(0,10)===today).length} sub="Production output" tone="green" />
        </div>
        <div className="dashboard-grid">
          <div className="panel span-2"><div className="panel-head"><div><h2>Active production</h2><p>Live location and timing for every open job</p></div><button className="text-button" onClick={()=>setPage("jobs")}>View all →</button></div><JobTable jobs={activeJobs.slice(0,6)} deptName={deptName} settings={state.settings} highlightDeadlines={state.settings.deadlineHighlighting} onPrint={setPrintJob} onOpen={setSelectedJob}/></div>
          <div className="panel"><div className="panel-head"><div><h2>Recent scans</h2><p>Latest shop-floor movements</p></div><span className="live-pill"><i/>LIVE</span></div><ScanList scans={state.scans.slice(0,5)} /></div>
        </div>
      </section>}

      {page === "create" && <section className="create-grid">
        <form className="panel job-form" onSubmit={createJob}><div className="panel-head"><div><h2>Create a production job</h2><p>Enter the job details and choose its expected route.</p></div></div>
          <div className="form-grid"><label><span>PACE job number *</span><input name="jobNumber" required placeholder="e.g. 590042" value={jobNumberInput} onChange={event=>{const value=event.target.value.toUpperCase();setJobNumberInput(value);setLabelJobNumber(value)}} /></label><label><span>Customer *</span><input name="customer" required placeholder="Customer name" /></label><label className="wide"><span>Job description *</span><input name="description" required placeholder="Project name or description" /></label><label><span>Production due date *</span><CalendarDatePicker name="dueDate" value={jobDueDate} min={localDateValue()} onChange={setJobDueDate}/></label><label><span>Priority</span><select name="priority" defaultValue="Standard"><option>Standard</option><option>Rush</option><option>Critical</option></select></label><label className="wide"><span>Starting location <small>Optional</small></span><select name="initialDepartmentId" defaultValue=""><option value="">Not started</option>{departments.filter(department=>department.enabled).map(department=><option key={department.id} value={department.id}>{department.name}</option>)}</select><small className="field-help">Leave this as Not started unless the job is already in a production department.</small></label><label className="wide overtime-create-option"><input type="checkbox" name="overtime"/><span><b>Overtime tracking</b><small>Count evenings, nights, and weekends for this job.</small></span></label><label className="wide"><span>Production notes</span><textarea name="notes" rows={3} placeholder="Materials, finishing notes, or special handling" /></label></div>
          <fieldset><legend>Expected production route</legend><p>Select the departments this job is expected to visit. This list is editable later.</p><div className="route-options">{departments.filter(d=>d.enabled).map(d=><label key={d.id}><input type="checkbox" name={`route-${d.id}`} defaultChecked/><span className="route-num">{d.order}</span><div><b>{d.name}</b><small>{d.prefix}|</small></div></label>)}</div></fieldset>
          <fieldset className={`create-split-section ${createAsSplit?"open":""}`}><div className="create-split-toggle"><div><h3>Does this job need separate tracked parts?</h3><p>Most jobs should remain off. Turn this on only when physical portions will move independently.</p></div><label className="switch" aria-label="Create this as a split job"><input type="checkbox" checked={createAsSplit} onChange={event=>setCreateAsSplit(event.target.checked)}/><span/></label></div>{createAsSplit&&<><div className="create-part-list">{createParts.map((part,index)=><div className="create-part-row" key={index}><span className="create-part-code">{jobNumberInput||"JOB"}-{String.fromCharCode(65+index)}</span><label><span>Part name *</span><input required value={part.name} onChange={event=>setCreateParts(current=>current.map((item,itemIndex)=>itemIndex===index?{...item,name:event.target.value}:item))}/></label><label><span>Description</span><input value={part.description} placeholder="What belongs with this part?" onChange={event=>setCreateParts(current=>current.map((item,itemIndex)=>itemIndex===index?{...item,description:event.target.value}:item))}/></label><label><span>Quantity</span><input value={part.quantity} placeholder="Optional" onChange={event=>setCreateParts(current=>current.map((item,itemIndex)=>itemIndex===index?{...item,quantity:event.target.value}:item))}/></label>{createParts.length>2&&<button type="button" aria-label={`Remove ${part.name}`} onClick={()=>setCreateParts(current=>current.filter((_,itemIndex)=>itemIndex!==index))}>×</button>}</div>)}</div><button type="button" className="add-create-part" onClick={()=>setCreateParts(current=>current.length>=26?current:[...current,{name:`Part ${String.fromCharCode(65+current.length)}`,description:"",quantity:""}])}>+ Add another part</button></>}</fieldset>
          <div className="form-actions"><button type="reset" className="secondary" onClick={()=>{setJobNumberInput("");setLabelJobNumber("");setJobDueDate(localDateValue(3));setCreateAsSplit(false);setCreateParts([{name:"Part A",description:"",quantity:""},{name:"Part B",description:"",quantity:""}])}}>Clear form</button><button type="submit" className="primary">Create job</button></div>
        </form>
        <div className="panel label-preview"><p className="eyebrow">LABEL PREVIEW</p><h2>{createAsSplit?"Part barcodes":"Job barcode"}</h2><p>{createAsSplit?"Each independently tracked part receives its own barcode.":"The barcode updates automatically as you enter the unique PACE job number."}</p><div className="paper-label"><small>{createAsSplit?"PRODUCTION JOB PART · PART A":"PRODUCTION JOB"}</small><strong>{labelJobNumber ? `${labelJobNumber}${createAsSplit?"-A":""}` : "Enter job number"}</strong>{labelJobNumber ? <Code128 value={`${labelJobNumber}${createAsSplit?"-A":""}`}/> : <div className="barcode-placeholder">Barcode preview</div>}<p>{createAsSplit?`${createParts.length} individual part labels will be available after creation.`:"Attach this label to the job jacket."}</p></div>{createAsSplit?<button className="secondary" disabled>Print part labels from Active Jobs</button>:<button className="secondary" disabled={!state.jobs.some(job=>job.jobNumber===labelJobNumber)} onClick={openCreatedJobLabel}>Print Barcode Label</button>}{labelJobNumber&&!createAsSplit&&!state.jobs.some(job=>job.jobNumber===labelJobNumber)&&<small className="save-before-print">Create the job first to enable printing.</small>}</div>
      </section>}

      {page === "jobs" && <section className="jobs-workspace" ref={activeJobsRef}>
        {jobGroups.map((group,index)=><section className={`panel job-group ${index===0&&jobControlsOpen?"controls-open":""}`} key={group.key}>
          <div className="group-heading"><div><h2>{group.label}</h2><p>{group.jobs.length} {group.jobs.length===1?"job":"jobs"}</p></div>{index===0&&<div className="jobs-toolbar-actions"><button type="button" className="fullscreen-toggle" onClick={toggleActiveJobsFullscreen}>{jobsFullscreen?<svg className="toolbar-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M8 3v5H3M12 17v-5h5M3 8l5-5M17 12l-5 5"/></svg>:<svg className="toolbar-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3H3v4M13 3h4v4M17 13v4h-4M7 17H3v-4"/></svg>}<span>{jobsFullscreen?"Exit full screen":"Full screen"}</span></button><button type="button" className="controls-toggle" aria-expanded={jobControlsOpen} aria-controls="active-job-controls" onClick={()=>setJobControlsOpen(open=>!open)}><span>{jobControlsOpen?"Hide controls":"Search, organize & sort"}</span><svg className="toolbar-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button></div>}</div>
          {index===0&&jobControlsOpen&&<div className="job-controls" id="active-job-controls"><label><span>Search</span><input className="search" placeholder="Job, customer, or description" value={query} onChange={e=>setQuery(e.target.value)}/></label><div className="control-field"><span>Departments</span><DepartmentMultiSelect departments={departments} value={departmentFilter} onChange={setDepartmentFilter}/></div><label><span>Organize</span><select value={groupBy} onChange={e=>setGroupBy(e.target.value as typeof groupBy)}><option value="none">Overall view</option><option value="location">Group by department</option><option value="customer">Group by customer</option></select></label><label><span>Sort</span><select value={sortBy} onChange={e=>setSortBy(e.target.value as typeof sortBy)}><option value="recent">Most recently moved</option><option value="due">Due date — soonest</option><option value="priority">Priority — critical first</option><option value="time">Longest time here</option><option value="job">Job number</option><option value="customer">Customer name</option></select></label></div>}
          <JobTable jobs={group.jobs} deptName={deptName} settings={state.settings} detailed highlightDeadlines={state.settings.deadlineHighlighting} showActions={jobActionsOpen} collapsibleActions onToggleActions={()=>setJobActionsOpen(open=>!open)} onPrint={setPrintJob} onPrintPart={(job,part)=>setPrintPart({job,part})} onOpen={setSelectedJob} onSplit={setSplitJob} departments={departments} statuses={statuses} allowDateEditing={canChangeSchedule} onInlineUpdate={updateJobInline} onInlinePartUpdate={updatePartInline}/>
        </section>)}
      </section>}

      {page === "history" && <section className="panel"><div className="panel-head"><div><h2>Permanent movement history</h2><p>The newest 300 movements load instantly. Older records remain in Firestore and can be loaded in pages.</p></div><span className="count-pill">{historyScans.length} loaded</span></div><div className="history-list">{historyScans.map(scan=>{const job=state.jobs.find(item=>item.jobNumber===scan.jobNumber||item.parts?.some(part=>part.code===scan.jobNumber));const part=job?.parts?.find(item=>item.code===scan.jobNumber);return <div className="history-row" key={scan.id}><div className="timeline-dot"/><time>{new Date(scan.timestamp).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}</time><strong>Job {scan.jobNumber}</strong><span>{scan.partName&&<>{scan.partName} · </>}{scan.statusName?<>changed to <b>{scan.statusName}</b> in {scan.departmentName}</>:<>moved to <b>{scan.departmentName}</b></>}</span><em className={scan.type==="Normal"?"normal":"exception"}>{scan.type}</em>{job&&(part?<button className="barcode-action" onClick={()=>setPrintPart({job,part})}>▥ Reprint</button>:<button className="barcode-action" onClick={()=>setPrintJob(job)}>▥ Reprint</button>)}</div>})}</div>{historyHasMore&&<div className="history-load-more"><button type="button" className="secondary" disabled={historyLoading} onClick={()=>void loadOlderHistory()}>{historyLoading?"Loading older history…":"Load 250 older movements"}</button><small>Loading older pages does not affect live scanner performance.</small></div>}</section>}

      {page === "admin" && hasAdministrationAccess && <><ReadyForBilling jobs={state.jobs} statuses={statuses} autoDelete={state.settings.billingAutoDeleteApproved30Days} onChangeAutoDelete={billingAutoDeleteApproved30Days=>persist({...state,settings:{...state.settings,billingAutoDeleteApproved30Days}})} onApprove={approveForBilling} onClear={clearFromBilling} onUpdate={updateBillingDetails}/><ReportsBackupPanel onReport={setManagementReport} onBackup={()=>downloadExcelBackup(state)}/>{isSuperAdmin&&<UserAccessPanel currentUid={user.uid}/>}<ProductionPortalAdminCard/><ViewerPortalAdminCard/><DataMaintenancePanel jobCount={state.jobs.length} onClearAllJobs={clearAllJobData}/><Admin departments={departments} statuses={statuses} jobs={state.jobs} settings={state.settings} onChangeSettings={(settings)=>persist({...state,settings})} onSave={(next)=>persist({...state,departments:next})} onSaveStatuses={saveStatuses} onPrintStatuses={setStatusPrint} onReset={()=>{const next=dataService.reset();persist(next);setNotice({kind:"success",title:"Demo data restored",detail:"Placeholder departments, statuses, and sample jobs were reset."})}} /></>}
    </main>
    {printJob && <OverlayPortal target={jobsFullscreen?activeJobsRef.current:null}><div className="reprint-overlay" role="dialog" aria-modal="true" aria-label={`Reprint barcode for job ${printJob.jobNumber}`}><div className="reprint-modal"><div className="reprint-head"><div><p className="eyebrow">BARCODE REPRINT</p><h2>Job {printJob.jobNumber}</h2></div><button aria-label="Close barcode reprint" onClick={()=>setPrintJob(null)}>×</button></div><div className="reprint-sheet"><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><small>PRODUCTION JOB</small><strong>{printJob.jobNumber}</strong><Code128 value={printJob.jobNumber}/><div className="reprint-details"><b>{printJob.customer}</b><span>{printJob.description}</span></div></div><div className="reprint-actions"><button className="secondary" onClick={()=>setPrintJob(null)}>Cancel</button><button className="primary" onClick={printBarcode}>Print Barcode Label</button></div></div></div></OverlayPortal>}
    {printPart && <OverlayPortal target={jobsFullscreen?activeJobsRef.current:null}><div className="reprint-overlay" role="dialog" aria-modal="true" aria-label={`Reprint barcode for ${printPart.part.code}`}><div className="reprint-modal"><div className="reprint-head"><div><p className="eyebrow">PART BARCODE</p><h2>{printPart.part.code}</h2></div><button aria-label="Close part barcode reprint" onClick={()=>setPrintPart(null)}>×</button></div><div className="reprint-sheet part-label-sheet"><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><small>PRODUCTION JOB PART</small><strong>{printPart.part.code}</strong><Code128 value={printPart.part.code}/><div className="reprint-details"><b>{printPart.part.name}</b><span>{printPart.part.description||printPart.job.description}</span>{printPart.part.quantity&&<span>Quantity: {printPart.part.quantity}</span>}<span>Parent Job: {printPart.job.jobNumber} · {printPart.job.customer}</span></div></div><div className="reprint-actions"><button className="secondary" onClick={()=>setPrintPart(null)}>Cancel</button><button className="primary" onClick={printBarcode}>Print Part Label</button></div></div></div></OverlayPortal>}
    {selectedJob && <OverlayPortal target={jobsFullscreen?activeJobsRef.current:null}>{hasAdministrationAccess?<div className="job-review-stack"><JobEditor key={selectedJob.id} job={selectedJob} departments={departments} statuses={statuses} canChangeSchedule={canChangeSchedule} onClose={()=>setSelectedJob(null)} onSave={saveJobOverride} onPrint={()=>{setSelectedJob(null);setPrintJob(selectedJob)}} /><ActiveJobDeleteAction job={selectedJob} onDelete={deleteJobPermanently}/></div>:<JobEditor key={selectedJob.id} job={selectedJob} departments={departments} statuses={statuses} canChangeSchedule={canChangeSchedule} onClose={()=>setSelectedJob(null)} onSave={saveJobOverride} onPrint={()=>{setSelectedJob(null);setPrintJob(selectedJob)}} />}</OverlayPortal>}
    {splitJob && <OverlayPortal target={jobsFullscreen?activeJobsRef.current:null}><SplitJobDialog job={splitJob} onClose={()=>setSplitJob(null)} onSave={parts=>saveJobSplit(splitJob,parts)}/></OverlayPortal>}
    {statusPrint && <StatusPrintSheet statuses={statusPrint} onClose={()=>setStatusPrint(null)} onPrint={printStatusBarcodes}/>} 
    {managementReport && <ManagementReport type={managementReport} state={state} onClose={()=>setManagementReport(null)} onPrint={printManagementReport}/>} 
    {migrationRequired && <div className="migration-overlay" role="dialog" aria-modal="true" aria-label="Initialize shared PlantFlow data"><div className="migration-card"><p className="eyebrow">ONE-TIME CLOUD SETUP</p><h2>Choose the shared starting data</h2><p>No shared PlantFlow records exist yet. Nothing will be uploaded until you choose an option.</p><div className="migration-options"><button className="primary" onClick={()=>void initializeSharedData("local")}><b>Use this device’s PlantFlow data</b><span>Uploads the jobs, history, departments, and statuses currently shown here.</span></button><button className="secondary" onClick={()=>void initializeSharedData("sample")}><b>Start with fresh sample data</b><span>Creates a clean shared pilot using the placeholder jobs and departments.</span></button></div><small>Recommended: use this device’s data if it contains the PlantFlow records you want to keep.</small></div></div>}
  </div>;
}

function ProductionFloorPortal({state,notice,onDismissNotice,onReview,onPrint,onPrintPart,onSplit,onUpdateJob,onUpdatePart}:{state:typeof seedState;notice:Notice;onDismissNotice:()=>void;onReview:(job:Job)=>void;onPrint:(job:Job)=>void;onPrintPart:(job:Job,part:JobPart)=>void;onSplit:(job:Job)=>void;onUpdateJob:(job:Job,field:"location"|"status"|"dueDate"|"priority"|"notes",value:string)=>void;onUpdatePart:(job:Job,part:JobPart,field:"location"|"status",value:string)=>void}) {
  type ViewerTheme="classic"|"graphite";
  const [search,setSearch]=useState("");
  const [departmentFilter,setDepartmentFilter]=useState<DepartmentSelection>(null);
  const [group,setGroup]=useState<"none"|"department"|"customer"|"status"|"priority">("none");
  const [sort,setSort]=useState<"due"|"recent"|"job"|"customer"|"priority">("recent");
  const [expandedJobs,setExpandedJobs]=useState<string[]>([]);
  const [noteDrafts,setNoteDrafts]=useState<Record<string,string>>({});
  const [summaryOpen,setSummaryOpen]=useState(false);
  const [controlsOpen,setControlsOpen]=useState(false);
  const [viewerTheme,setViewerTheme]=useState<ViewerTheme>(()=>window.localStorage.getItem("plantflow-production-portal-theme-v1")==="graphite"?"graphite":"classic");
  const changeViewerTheme=(theme:ViewerTheme)=>{setViewerTheme(theme);window.localStorage.setItem("plantflow-production-portal-theme-v1",theme)};
  const departmentName=(id:string)=>state.departments.find(item=>item.id===id)?.name||"Not started";
  const active=state.jobs.filter(job=>!jobIsClosed(job,state.statuses));
  const visibleJobs=useMemo(()=>{
    const term=search.trim().toLowerCase();
    const priorityRank={Critical:0,Rush:1,Standard:2};
    return active.filter(job=>jobIsInDepartments(job,departmentFilter)&&`${job.jobNumber} ${job.customer} ${job.description} ${parentLocation(job,departmentName)} ${parentStatus(job)}`.toLowerCase().includes(term)).sort((a,b)=>{
      if(sort==="recent")return parentUpdatedAt(b).localeCompare(parentUpdatedAt(a));
      if(sort==="job")return a.jobNumber.localeCompare(b.jobNumber,undefined,{numeric:true});
      if(sort==="customer")return a.customer.localeCompare(b.customer)||a.dueDate.localeCompare(b.dueDate);
      if(sort==="priority")return priorityRank[a.priority]-priorityRank[b.priority]||a.dueDate.localeCompare(b.dueDate);
      return a.dueDate.localeCompare(b.dueDate);
    });
  },[active,departmentFilter,search,sort,state.departments]);
  const groups=useMemo(()=>{
    if(group==="none")return [{key:"all",label:departmentFilter===null?"All active jobs":`${departmentSelectionLabel(departmentFilter,departmentName)} jobs`,jobs:visibleJobs}];
    const buckets=new Map<string,Job[]>();
    visibleJobs.forEach(job=>{const key=group==="department"?parentLocation(job,departmentName):group==="customer"?job.customer:group==="status"?parentStatus(job):job.priority;buckets.set(key,[...(buckets.get(key)||[]),job])});
    const grouped=[...buckets.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,jobs])=>({key,label:key,jobs}));
    return grouped.length?grouped:[{key:"empty",label:"No matching jobs",jobs:[]}];
  },[group,visibleJobs,departmentFilter,state.departments]);
  const enabledDepartments=state.departments.filter(item=>item.enabled).sort((a,b)=>a.order-b.order);
  const enabledStatuses=state.statuses.filter(item=>item.enabled).sort((a,b)=>a.order-b.order);
  const today=localDateValue();
  const routeHistory=(job:Job)=>{
    const trackedCodes=new Set([job.jobNumber,...(job.parts||[]).map(part=>part.code)]);
    const movements=state.scans
      .filter(scan=>trackedCodes.has(scan.jobNumber))
      .sort((a,b)=>a.timestamp.localeCompare(b.timestamp))
      .map(scan=>scan.departmentName||departmentName(scan.departmentId));
    return movements.filter((name,index)=>index===0||name!==movements[index-1]).join(" → ")||"No recorded movements yet";
  };
  const toggleExpanded=(jobId:string)=>setExpandedJobs(current=>current.includes(jobId)?current.filter(id=>id!==jobId):[...current,jobId]);
  return <div className={`viewer-portal production-floor-portal viewer-theme-${viewerTheme}`}>
    <header className="viewer-header"><div className="viewer-brand"><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><div><p className="eyebrow">PLANTFLOW PRODUCTION</p><h1>Production Floor Portal</h1><span>Review and update live production jobs from the shop floor.</span></div></div><div className="viewer-header-tools"><div className="viewer-theme-toggle" role="group" aria-label="Production portal color mode"><button type="button" className={viewerTheme==="classic"?"active":""} aria-pressed={viewerTheme==="classic"} onClick={()=>changeViewerTheme("classic")}>Light</button><button type="button" className={viewerTheme==="graphite"?"active":""} aria-pressed={viewerTheme==="graphite"} onClick={()=>changeViewerTheme("graphite")}>Dark</button></div><div className="viewer-updated"><i/><div><b>Live editing enabled</b><span>Updated {new Date().toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</span></div></div></div></header>
    <main className="viewer-main">
      {notice&&<div className={`production-portal-notice ${notice.kind}`} role="status"><span>{notice.kind==="success"?"✓":"!"}</span><div><b>{notice.title}</b><small>{notice.detail}</small></div><button type="button" aria-label="Dismiss message" onClick={onDismissNotice}>×</button></div>}
      <div className="viewer-section-toggles"><button type="button" aria-expanded={summaryOpen} onClick={()=>setSummaryOpen(current=>!current)}><span>Production summary</span><small>{active.length} active · {visibleJobs.length} shown</small><b>{summaryOpen?"⌃":"⌄"}</b></button><button type="button" aria-expanded={controlsOpen} onClick={()=>setControlsOpen(current=>!current)}><span>Find, filter & arrange</span><small>{departmentFilter===null?"All departments":departmentSelectionLabel(departmentFilter,departmentName)}</small><b>{controlsOpen?"⌃":"⌄"}</b></button></div>
      {summaryOpen&&<section className="viewer-metrics viewer-collapsible-section"><div><span>Active jobs</span><b>{active.length}</b></div><div><span>Shown</span><b>{visibleJobs.length}</b></div><div><span>Due today</span><b>{active.filter(job=>job.dueDate===today).length}</b></div><div><span>Rush / critical</span><b>{active.filter(job=>job.priority!=="Standard").length}</b></div></section>}
      {controlsOpen&&<section className="viewer-controls production-portal-controls panel viewer-collapsible-section"><label className="viewer-search"><span>Find a job</span><input placeholder="Job, customer, description…" value={search} onChange={event=>setSearch(event.target.value)}/></label><div className="control-field"><span>Departments</span><DepartmentMultiSelect departments={state.departments} value={departmentFilter} onChange={setDepartmentFilter} compact/></div><label><span>View</span><select value={group} onChange={event=>setGroup(event.target.value as typeof group)}><option value="none">Overall view</option><option value="department">Group by department</option><option value="customer">Group by customer</option><option value="status">Group by status</option><option value="priority">Group by priority</option></select></label><label><span>Sort</span><select value={sort} onChange={event=>setSort(event.target.value as typeof sort)}><option value="recent">Most recently moved</option><option value="due">Due date — soonest</option><option value="priority">Priority — critical first</option><option value="job">Job number</option><option value="customer">Customer name</option></select></label></section>}
      <div className="production-mobile-guidance"><b>Tap location or status to update it.</b><span>Tap the rest of a job row to expand details, time here, and production notes.</span></div>
      <section className="viewer-groups production-portal-groups">{groups.map(bucket=><article className="panel viewer-group production-portal-group" key={bucket.key}><div className="viewer-group-head"><div><h2>{bucket.label}</h2><p>{bucket.jobs.length} {bucket.jobs.length===1?"job":"jobs"}</p></div></div><div className="viewer-table-wrap"><table className="viewer-table production-edit-table"><thead><tr><th>Job</th><th>Customer / Description</th><th>Department</th><th>Status</th><th>Priority</th><th>Due</th><th>Time here</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{bucket.jobs.map(job=><Fragment key={job.id}><tr className={`production-summary-row ${deadlineTone(job.dueDate,state.settings.deadlineHighlighting)} ${expandedJobs.includes(job.id)?"expanded":""}`} tabIndex={0} aria-expanded={expandedJobs.includes(job.id)} onClick={event=>{if((event.target as HTMLElement).closest("button,input,select,textarea,label"))return;toggleExpanded(job.id)}} onKeyDown={event=>{if((event.key==="Enter"||event.key===" ")&&!(event.target as HTMLElement).closest("button,input,select,textarea")){event.preventDefault();toggleExpanded(job.id)}}}><td><strong>{job.jobNumber}</strong>{job.notes&&<small className="viewer-note-indicator">● Note</small>}{job.parts?.length&&<small>{job.parts.length} tracked parts</small>}</td><td><b>{job.customer}</b><small>{job.description}</small></td><td>{job.parts?.length?<span className="department-pill">{parentLocation(job,departmentName)}</span>:<select aria-label={`Location for job ${job.jobNumber}`} className="production-pill-select department-pill" value={job.currentDepartmentId} onChange={event=>onUpdateJob(job,"location",event.target.value)}><option value="">Not started</option>{enabledDepartments.map(department=><option key={department.id} value={department.id}>{department.name}</option>)}</select>}</td><td>{job.parts?.length?<span className={`status-pill ${statusTone[parentStatus(job)]||"slate"}`}>{parentStatus(job)}</span>:<select aria-label={`Status for job ${job.jobNumber}`} className={`production-pill-select status-pill ${statusTone[job.status]||"slate"}`} value={job.status} onChange={event=>onUpdateJob(job,"status",event.target.value)}>{enabledStatuses.map(status=><option key={status.id}>{status.name}</option>)}</select>}</td><td><select aria-label={`Priority for job ${job.jobNumber}`} className={`production-priority-select priority-text ${job.priority.toLowerCase()}`} value={job.priority} onChange={event=>onUpdateJob(job,"priority",event.target.value)}><option>Standard</option><option>Rush</option><option>Critical</option></select></td><td><input aria-label={`Due date for job ${job.jobNumber}`} className="production-date-select" type="date" value={job.dueDate} onChange={event=>onUpdateJob(job,"dueDate",event.target.value)}/></td><td>{formatTrackedTime(parentUpdatedAt(job),state.settings,job.overtime)}</td><td><button type="button" className="production-expand-button" aria-label={`${expandedJobs.includes(job.id)?"Collapse":"Expand"} job ${job.jobNumber}`} onClick={()=>toggleExpanded(job.id)}>{expandedJobs.includes(job.id)?"⌃":"⌄"}</button></td></tr>{expandedJobs.includes(job.id)&&<tr className="production-expanded-row"><td colSpan={8}><div className="production-expanded-content"><div className="production-detail-summary"><span><b>Created</b>{new Date(job.createdAt).toLocaleDateString()}</span><span><b>Last movement</b>{new Date(parentUpdatedAt(job)).toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}</span><span><b>Time here</b>{formatTrackedTime(parentUpdatedAt(job),state.settings,job.overtime)}</span><span><b>Route history</b>{routeHistory(job)}</span></div>{job.parts?.length&&<div className="production-expanded-parts"><h3>Tracked job parts</h3>{job.parts.map(part=><div className="production-expanded-part" key={part.id}><div><b>{part.code}</b><span>{part.name}</span><small>{part.description||job.description}</small></div><label><span>Location</span><select value={part.currentDepartmentId} onChange={event=>onUpdatePart(job,part,"location",event.target.value)}><option value="">Not started</option>{enabledDepartments.map(department=><option key={department.id} value={department.id}>{department.name}</option>)}</select></label><label><span>Status</span><select value={part.status} onChange={event=>onUpdatePart(job,part,"status",event.target.value)}>{enabledStatuses.map(status=><option key={status.id}>{status.name}</option>)}</select></label></div>)}</div>}<label className="production-note-editor"><span>Production note</span><textarea rows={3} maxLength={1000} value={noteDrafts[job.id]??job.notes} onChange={event=>setNoteDrafts(current=>({...current,[job.id]:event.target.value}))} placeholder="Add a production note for this job…"/><div><small>This note is shared with PlantFlow users.</small><button type="button" onClick={()=>{onUpdateJob(job,"notes",noteDrafts[job.id]??job.notes);setNoteDrafts(current=>{const next={...current};delete next[job.id];return next})}}>Save note</button></div></label><div className="production-job-actions"><button type="button" onClick={()=>onReview(job)}>Review job</button>{!job.parts?.length&&<button type="button" onClick={()=>onPrint(job)}>▥ Reprint barcode</button>}{!job.parts?.length&&<button type="button" onClick={()=>onSplit(job)}>Split job</button>}</div></div></td></tr>}</Fragment>)}{!bucket.jobs.length&&<tr><td colSpan={8}><p className="viewer-empty">No jobs match the current view. Change the department selection or search to continue.</p></td></tr>}</tbody></table></div></article>)}</section>
      <footer className="viewer-footer">PlantFlow Production Floor Portal · Worth Higgins & Associates</footer>
    </main>
  </div>;
}

export function ReadOnlyPortal({state}:{state:typeof seedState}) {
  type ViewerTheme = "classic"|"graphite";
  const [search,setSearch]=useState("");
  const [scope,setScope]=useState<"active"|"starred"|"all">("active");
  const [group,setGroup]=useState<"none"|"department"|"customer"|"status"|"priority">("none");
  const [sort,setSort]=useState<"due"|"recent"|"job"|"customer"|"priority">("recent");
  const [departmentFilter,setDepartmentFilter]=useState<DepartmentSelection>(null);
  const [summaryOpen,setSummaryOpen]=useState(false);
  const [controlsOpen,setControlsOpen]=useState(false);
  const [starredJobs,setStarredJobs]=useState<string[]>(()=>{try{return JSON.parse(window.localStorage.getItem("plantflow-portal-starred-v1")||"[]")}catch{return []}});
  const [jobNotes,setJobNotes]=useState<Record<string,string>>(()=>{try{return JSON.parse(window.localStorage.getItem("plantflow-portal-notes-v1")||"{}")}catch{return {}}});
  const [noteJob,setNoteJob]=useState<Job|null>(null);
  const [portalReportOpen,setPortalReportOpen]=useState(false);
  const [viewerTheme,setViewerTheme]=useState<ViewerTheme>(()=>{
    const saved=window.localStorage.getItem("plantflow-portal-theme-v1");
    return saved==="midnight"||saved==="graphite"?"graphite":"classic";
  });
  const changeViewerTheme=(theme:ViewerTheme)=>{setViewerTheme(theme);window.localStorage.setItem("plantflow-portal-theme-v1",theme)};
  const toggleStar=(jobId:string)=>setStarredJobs(current=>{const next=current.includes(jobId)?current.filter(id=>id!==jobId):[...current,jobId];window.localStorage.setItem("plantflow-portal-starred-v1",JSON.stringify(next));return next});
  const saveJobNote=(jobId:string,note:string)=>setJobNotes(current=>{const next={...current};const clean=note.trim();if(clean)next[jobId]=clean;else delete next[jobId];window.localStorage.setItem("plantflow-portal-notes-v1",JSON.stringify(next));return next});
  const departmentName=(id:string)=>state.departments.find(item=>item.id===id)?.name||"Not started";
  const active=state.jobs.filter(job=>!jobIsClosed(job,state.statuses));
  const visibleJobs=useMemo(()=>{
    const source=scope==="active"?active:scope==="starred"?state.jobs.filter(job=>starredJobs.includes(job.id)):state.jobs;
    const filtered=source.filter(job=>jobIsInDepartments(job,departmentFilter)&&`${job.jobNumber} ${job.customer} ${job.description} ${parentLocation(job,departmentName)} ${parentStatus(job)}`.toLowerCase().includes(search.trim().toLowerCase()));
    const priorityRank={Critical:0,Rush:1,Standard:2};
    return [...filtered].sort((a,b)=>{
      if(sort==="recent") return parentUpdatedAt(b).localeCompare(parentUpdatedAt(a));
      if(sort==="job") return a.jobNumber.localeCompare(b.jobNumber,undefined,{numeric:true});
      if(sort==="customer") return a.customer.localeCompare(b.customer)||a.dueDate.localeCompare(b.dueDate);
      if(sort==="priority") return priorityRank[a.priority]-priorityRank[b.priority]||a.dueDate.localeCompare(b.dueDate);
      return a.dueDate.localeCompare(b.dueDate);
    });
  },[state.jobs,state.statuses,scope,search,sort,starredJobs,departmentFilter]);
  const groups=useMemo(()=>{
    if(group==="none") return [{key:"all",label:departmentFilter!==null?`${departmentSelectionLabel(departmentFilter,departmentName)} jobs`:scope==="active"?"All active jobs":scope==="starred"?"Starred jobs":"All job records",jobs:visibleJobs}];
    const buckets=new Map<string,Job[]>();
    visibleJobs.forEach(job=>{
      const key=group==="department"?parentLocation(job,departmentName):group==="customer"?job.customer:group==="status"?parentStatus(job):job.priority;
      buckets.set(key,[...(buckets.get(key)||[]),job]);
    });
    return [...buckets.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,jobs])=>({key,label:key,jobs}));
  },[group,visibleJobs,scope,state.departments,departmentFilter]);
  const today=localDateValue();
  return <div className={`viewer-portal viewer-theme-${viewerTheme}`}>
    <header className="viewer-header"><div className="viewer-brand"><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><div><p className="eyebrow">PLANTFLOW PORTAL</p><h1>Production Information Portal</h1><span>Review current production information and follow jobs as they move through the plant.</span></div></div><div className="viewer-header-tools"><div className="viewer-theme-toggle" role="group" aria-label="Viewer color mode"><button type="button" className={viewerTheme==="classic"?"active":""} aria-pressed={viewerTheme==="classic"} onClick={()=>changeViewerTheme("classic")} title="Use light mode">Light</button><button type="button" className={viewerTheme==="graphite"?"active":""} aria-pressed={viewerTheme==="graphite"} onClick={()=>changeViewerTheme("graphite")} title="Use dark mode">Dark</button></div><div className="viewer-updated"><i/><div><b>Live production view</b><span>Updated {new Date().toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</span></div></div></div></header>
    <main className="viewer-main">
      <div className="viewer-section-toggles"><button type="button" aria-expanded={summaryOpen} onClick={()=>setSummaryOpen(current=>!current)}><span>Production summary</span><small>{active.length} active · {active.filter(job=>job.dueDate===today).length} due today</small><b>{summaryOpen?"⌃":"⌄"}</b></button><button type="button" aria-expanded={controlsOpen} onClick={()=>setControlsOpen(current=>!current)}><span>Find, filter & arrange</span><small>{departmentFilter===null?"All departments":departmentSelectionLabel(departmentFilter,departmentName)}</small><b>{controlsOpen?"⌃":"⌄"}</b></button></div>
      {summaryOpen&&<section className="viewer-metrics viewer-collapsible-section"><div><span>Active jobs</span><b>{active.length}</b></div><div><span>Due today</span><b>{active.filter(job=>job.dueDate===today).length}</b></div><div><span>Overdue</span><b>{active.filter(job=>job.dueDate<today).length}</b></div><div><span>Rush / critical</span><b>{active.filter(job=>job.priority!=="Standard").length}</b></div></section>}
      {controlsOpen&&<section className="viewer-controls panel viewer-collapsible-section"><label className="viewer-search"><span>Find a job</span><input placeholder="Search job, customer, description, department…" value={search} onChange={event=>setSearch(event.target.value)}/></label><label><span>Records</span><select value={scope} onChange={event=>setScope(event.target.value as typeof scope)}><option value="active">Active jobs</option><option value="starred">★ Starred jobs ({starredJobs.length})</option><option value="all">All records</option></select></label><div className="control-field"><span>Departments</span><DepartmentMultiSelect departments={state.departments} value={departmentFilter} onChange={setDepartmentFilter} compact/></div><label><span>View</span><select value={group} onChange={event=>setGroup(event.target.value as typeof group)}><option value="none">Overall view</option><option value="department">Group by department</option><option value="customer">Group by customer</option><option value="status">Group by status</option><option value="priority">Group by priority</option></select></label><label><span>Sort</span><select value={sort} onChange={event=>setSort(event.target.value as typeof sort)}><option value="due">Due date — soonest</option><option value="recent">Most recently moved</option><option value="priority">Priority — critical first</option><option value="job">Job number</option><option value="customer">Customer name</option></select></label></section>}
      <div className="viewer-result-note"><span className="viewer-result-count"><b>{visibleJobs.length}</b> matching {visibleJobs.length===1?"job":"jobs"}</span><span className="viewer-result-live">Current production view · updated in real time</span><button type="button" className="viewer-report-button" onClick={()=>setPortalReportOpen(true)}>Print / PDF</button></div>
      <section className="viewer-groups">{groups.map(bucket=><article className="panel viewer-group" key={bucket.key}><div className="viewer-group-head"><div><h2>{bucket.label}</h2><p>{bucket.jobs.length} {bucket.jobs.length===1?"job":"jobs"}</p></div></div><div className="viewer-table-wrap"><table className="viewer-table"><thead><tr><th className="viewer-star-column"><span className="sr-only">Favorite</span></th><th>Job</th><th>Customer / Description</th><th>Department</th><th>Status</th><th>Priority</th><th>Due</th><th>Time here</th></tr></thead><tbody>{bucket.jobs.map(job=><Fragment key={job.id}><tr className={`viewer-job-row ${deadlineTone(job.dueDate,state.settings.deadlineHighlighting)}`} tabIndex={0} onClick={()=>setNoteJob(job)} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();setNoteJob(job)}}}><td className="viewer-star-column"><button type="button" className={`viewer-star ${starredJobs.includes(job.id)?"selected":""}`} aria-label={starredJobs.includes(job.id)?`Remove job ${job.jobNumber} from starred jobs`:`Star job ${job.jobNumber}`} title={starredJobs.includes(job.id)?"Remove star":"Star this job"} onClick={event=>{event.stopPropagation();toggleStar(job.id)}}>★</button></td><td><strong>{job.jobNumber}</strong>{jobNotes[job.id]&&<small className="viewer-note-indicator">● Note</small>}{job.parts?.length&&<small>{job.parts.length} tracked parts</small>}</td><td><b>{job.customer}</b><small>{job.description}</small></td><td><span className="department-pill">{parentLocation(job,departmentName)}</span></td><td><span className={`status-pill ${statusTone[parentStatus(job)]||"slate"}`}>{parentStatus(job)}</span></td><td><span className={`priority-text ${job.priority.toLowerCase()}`}>{job.priority}</span></td><td>{formatDate(job.dueDate)}</td><td>{formatTrackedTime(parentUpdatedAt(job),state.settings,job.overtime)}</td></tr>{job.parts?.map(part=><tr className="viewer-part-row" key={part.id} onClick={()=>setNoteJob(job)}><td className="viewer-star-column"/><td><strong>{part.code}</strong></td><td><b>{part.name}</b><small>{part.description||job.description}{part.quantity?` · Qty ${part.quantity}`:""}</small></td><td><span className="department-pill">{departmentName(part.currentDepartmentId)}</span></td><td><span className={`status-pill ${statusTone[part.status]||"slate"}`}>{part.status}</span></td><td><span className="priority-text">Part</span></td><td>{formatDate(job.dueDate)}</td><td>{formatTrackedTime(part.updatedAt,state.settings,job.overtime)}</td></tr>)}</Fragment>)}</tbody></table>{!bucket.jobs.length&&<p className="viewer-empty">{scope==="starred"?"No starred jobs yet. Select the star beside a job to add it here.":"No jobs match the current view."}</p>}</div></article>)}</section>
      <footer className="viewer-footer">PlantFlow Production Portal · Worth Higgins & Associates</footer>
    </main>
    {noteJob&&<PortalJobNoteDialog job={noteJob} note={jobNotes[noteJob.id]||""} department={parentLocation(noteJob,departmentName)} departmentName={departmentName} timeHere={formatTrackedTime(parentUpdatedAt(noteJob),state.settings,noteJob.overtime)} onClose={()=>setNoteJob(null)} onSave={note=>{saveJobNote(noteJob.id,note);setNoteJob(null)}}/>}
    {portalReportOpen&&<PortalViewReport groups={groups} notes={jobNotes} departmentName={departmentName} scope={scope} search={search} sort={sort} onClose={()=>setPortalReportOpen(false)}/>} 
  </div>;
}

function PortalJobNoteDialog({job,note,department,departmentName,timeHere,onClose,onSave}:{job:Job;note:string;department:string;departmentName:(id:string)=>string;timeHere:string;onClose:()=>void;onSave:(note:string)=>void}) {
  const [draft,setDraft]=useState(note);
  return <div className="portal-note-overlay" role="dialog" aria-modal="true" aria-label={`Personal note for job ${job.jobNumber}`}>
    <div className="portal-note-card">
      <div className="portal-note-head"><div><p className="eyebrow">MY PORTAL NOTE</p><h2>Job {job.jobNumber}</h2><span>{job.customer} · {department}</span><span className="portal-note-time">Time here: {timeHere}</span></div><button type="button" aria-label="Close note" onClick={onClose}>×</button></div>
      <p className="portal-note-description">Add a discussion point, reminder, or follow-up for this job. This note stays in this browser and does not change the production record.</p>
      {job.parts?.length&&<div className="portal-part-details"><b>Tracked job parts</b>{job.parts.map(part=><div key={part.id}><span><strong>{part.code}</strong>{part.name}</span><span>{departmentName(part.currentDepartmentId)}</span><span>{part.status}</span></div>)}</div>}
      <label><span>Note</span><textarea autoFocus maxLength={750} rows={6} value={draft} onChange={event=>setDraft(event.target.value)} placeholder="Add a note for your next production discussion…"/></label>
      <div className="portal-note-count">{draft.length} / 750</div>
      <div className="portal-note-actions">{note&&<button type="button" className="portal-note-clear" onClick={()=>setDraft("")}>Clear note</button>}<button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="button" className="primary" onClick={()=>onSave(draft)}>Save note</button></div>
    </div>
  </div>;
}

function PortalViewReport({groups,notes,departmentName,scope,search,sort,onClose}:{groups:{key:string;label:string;jobs:Job[]}[];notes:Record<string,string>;departmentName:(id:string)=>string;scope:"active"|"starred"|"all";search:string;sort:string;onClose:()=>void}) {
  const titleBefore = useRef(document.title);
  useEffect(()=>{
    const finish=()=>{document.body.classList.remove("printing-portal-view");document.title=titleBefore.current};
    window.addEventListener("afterprint",finish);
    return()=>{window.removeEventListener("afterprint",finish);finish()};
  },[]);
  const print=()=>{
    titleBefore.current=document.title;
    document.title=`PlantFlow_Portal_View_${localDateValue()}`;
    document.body.classList.add("printing-portal-view");
    window.setTimeout(()=>window.print(),100);
  };
  const jobCount=groups.reduce((total,group)=>total+group.jobs.length,0);
  const scopeLabel=scope==="active"?"Active jobs":scope==="starred"?"Starred jobs":"All job records";
  return <div className="portal-report-overlay" role="dialog" aria-modal="true" aria-label="Current portal view report">
    <div className="portal-report-modal"><div className="portal-note-head portal-report-head"><div><p className="eyebrow">PRINT / PDF PREVIEW</p><h2>Current Production View</h2><span>{jobCount} {jobCount===1?"job":"jobs"} · {scopeLabel}</span></div><button type="button" aria-label="Close report" onClick={onClose}>×</button></div>
      <article className="portal-print-sheet">
        <header><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><div><p>PLANTFLOW PORTAL</p><h1>Current Production View</h1><span>{new Date().toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric",year:"numeric"})}</span></div></header>
        <div className="portal-print-summary"><span><b>{jobCount}</b>Jobs shown</span><span><b>{groups.reduce((total,group)=>total+group.jobs.filter(job=>notes[job.id]).length,0)}</b>Notes included</span><span><b>{scopeLabel}</b>Record selection</span><span><b>{sort.replace("recent","Recently moved").replace("due","Due date").replace("priority","Priority").replace("job","Job number").replace("customer","Customer")}</b>Sort order</span></div>
        {search&&<p className="portal-print-filter">Search filter: <b>{search}</b></p>}
        {groups.map(group=><section className="portal-print-group" key={group.key}><h2>{group.label}<span>{group.jobs.length}</span></h2><table><thead><tr><th>Job</th><th>Customer / Description</th><th>Department</th><th>Status</th><th>Priority</th><th>Due</th></tr></thead><tbody>{group.jobs.map(job=><Fragment key={job.id}><tr className={notes[job.id]?"portal-print-job-with-note":""}><td><b>{job.jobNumber}</b></td><td><b>{job.customer}</b><small>{job.description}</small></td><td>{parentLocation(job,departmentName)}</td><td>{parentStatus(job)}</td><td>{job.priority}</td><td>{formatDate(job.dueDate)}</td></tr>{notes[job.id]&&<tr className="portal-print-note"><td colSpan={6}><div><b>{job.jobNumber} · Note</b><span>{notes[job.id]}</span></div></td></tr>}</Fragment>)}</tbody></table></section>)}
        <footer>Prepared from the PlantFlow Production Information Portal · Personal notes are stored on this viewer’s device</footer>
      </article>
      <div className="portal-report-actions"><button type="button" className="secondary" onClick={onClose}>Close</button><button type="button" className="primary" onClick={print}>Print / Save as PDF</button></div>
    </div>
  </div>;
}

function Metric({label,value,sub,tone="blue"}:{label:string;value:number;sub:string;tone?:string}) { return <div className={`metric ${tone}`}><div><p>{label}</p><strong>{value}</strong><small>{sub}</small></div></div>; }

function JobTable({jobs,deptName,settings,detailed=false,highlightDeadlines=false,showActions=true,collapsibleActions=false,onToggleActions,onPrint,onPrintPart,onOpen,onSplit,departments,statuses,allowDateEditing=true,onInlineUpdate,onInlinePartUpdate}:{jobs:Job[];deptName:(id:string)=>string;settings:AppSettings;detailed?:boolean;highlightDeadlines?:boolean;showActions?:boolean;collapsibleActions?:boolean;onToggleActions?:()=>void;onPrint?:(job:Job)=>void;onPrintPart?:(job:Job,part:JobPart)=>void;onOpen?:(job:Job)=>void;onSplit?:(job:Job)=>void;departments?:Department[];statuses?:StatusDefinition[];allowDateEditing?:boolean;onInlineUpdate?:(job:Job,field:"location"|"status"|"dueDate"|"priority",value:string)=>void;onInlinePartUpdate?:(job:Job,part:JobPart,field:"location"|"status",value:string)=>void}) {
  const actionsAvailable=Boolean(onPrint||onOpen);
  const actionsVisible=showActions&&actionsAvailable;
  const inlineEditing=Boolean(onInlineUpdate&&departments&&statuses);
  const partInlineEditing=Boolean(onInlinePartUpdate&&departments&&statuses);
  const [expanded,setExpanded]=useState<Record<string,boolean>>({});
  const locationOptions=<><option value="">Not started</option>{departments?.filter(item=>item.enabled).sort((a,b)=>a.order-b.order).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</>;
  const statusOptions=statuses?.filter(item=>item.enabled).sort((a,b)=>a.order-b.order).map(item=><option key={item.id} value={item.name}>{item.name}</option>);
  return <div className="table-scroll"><table><thead><tr><th>Job</th><th>Customer / Description</th><th>Location</th><th>Status</th><th>Due</th>{detailed&&<th>Priority</th>}<th className="time-here-column">Time here</th>{collapsibleActions&&actionsAvailable?<th className={`actions-drawer-heading ${actionsVisible?"open":"closed"}`}><button type="button" className="table-actions-toggle" aria-label={actionsVisible?"Hide actions":"Show actions"} aria-expanded={actionsVisible} onClick={onToggleActions}><b aria-hidden="true">›</b><span className="actions-tooltip" role="tooltip">Actions</span></button></th>:actionsVisible&&<th className="actions-heading">Actions</th>}</tr></thead><tbody>{jobs.map(job=>{
    const parts=job.parts||[];
    const split=parts.length>0;
    const open=Boolean(expanded[job.id]);
    const location=parentLocation(job,deptName);
    const status=parentStatus(job);
    return <Fragment key={job.id}><tr className={`${onOpen?"reviewable-row ":""}${split?"split-parent-row ":""}${deadlineTone(job.dueDate,highlightDeadlines)}`.trim()} onDoubleClick={()=>onOpen?.(job)}><td><div className="job-number-cell">{split&&<button type="button" className="parts-toggle" aria-label={`${open?"Hide":"Show"} parts for job ${job.jobNumber}`} aria-expanded={open} onClick={event=>{event.stopPropagation();setExpanded(current=>({...current,[job.id]:!open}))}}>{open?"⌄":"›"}</button>}<b className="job-num">{job.jobNumber}</b>{split&&<small className="parts-count">{parts.length} parts</small>}</div></td><td><b>{job.customer}</b><small>{job.description}</small></td><td>{inlineEditing&&!split?<select className="department-pill inline-pill-select" aria-label={`Change location for job ${job.jobNumber}`} title="Click to change location" value={job.currentDepartmentId} onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()} onChange={event=>onInlineUpdate?.(job,"location",event.target.value)}>{locationOptions}</select>:<span className={`department-pill ${split&&location==="Multiple locations"?"multiple":""}`}>{location}</span>}</td><td>{inlineEditing&&!split?<select className={`status-pill inline-pill-select ${statusTone[job.status]||"slate"}`} aria-label={`Change status for job ${job.jobNumber}`} title="Click to change status" value={job.status} onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()} onChange={event=>onInlineUpdate?.(job,"status",event.target.value)}>{statusOptions}</select>:<span className={`status-pill ${statusTone[status]||"slate"}`}>{status}</span>}</td><td>{inlineEditing&&allowDateEditing?<span className={`inline-date-control ${job.dueDate < localDateValue()?"overdue":""}`} title="Click to change due date"><span aria-hidden="true">{formatDate(job.dueDate)}</span><input type="date" aria-label={`Change due date for job ${job.jobNumber}`} value={job.dueDate} onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()} onChange={event=>onInlineUpdate?.(job,"dueDate",event.target.value)}/></span>:<span className={job.dueDate < localDateValue()?"overdue":""}>{formatDate(job.dueDate)}</span>}</td>{detailed&&<td>{inlineEditing?<select className={`priority inline-priority-select ${job.priority.toLowerCase()}`} aria-label={`Change priority for job ${job.jobNumber}`} title="Click to change priority" value={job.priority} onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()} onChange={event=>onInlineUpdate?.(job,"priority",event.target.value)}><option>Standard</option><option>Rush</option><option>Critical</option></select>:<b className={`priority ${job.priority.toLowerCase()}`}>{job.priority}</b>}</td>}<td className="time-here-column">{formatTrackedTime(parentUpdatedAt(job),settings,job.overtime)}</td>{actionsVisible?<td className="actions-cell"><div className="row-actions">{onOpen&&<button className="review-action" onClick={()=>onOpen(job)}>Review</button>}{onPrint&&!split&&<button className="barcode-action" onClick={()=>onPrint(job)}>▥ Reprint</button>}{onSplit&&!split&&<button className="split-action" onClick={()=>onSplit(job)}>Split</button>}</div></td>:collapsibleActions&&actionsAvailable?<td className="actions-closed-cell" aria-hidden="true"/>:null}</tr>{open&&parts.map(part=><tr key={part.id} className="job-part-row"><td><div className="part-code"><span>↳</span><b>{part.code}</b></div></td><td><b>{part.name}</b><small>{part.description||"Job part"}{part.quantity?` · Qty ${part.quantity}`:""}</small></td><td>{partInlineEditing?<select className="department-pill inline-pill-select" aria-label={`Change location for ${part.code}`} value={part.currentDepartmentId} onChange={event=>onInlinePartUpdate?.(job,part,"location",event.target.value)}>{locationOptions}</select>:<span className="department-pill">{deptName(part.currentDepartmentId)}</span>}</td><td>{partInlineEditing?<select className={`status-pill inline-pill-select ${statusTone[part.status]||"slate"}`} aria-label={`Change status for ${part.code}`} value={part.status} onChange={event=>onInlinePartUpdate?.(job,part,"status",event.target.value)}>{statusOptions}</select>:<span className={`status-pill ${statusTone[part.status]||"slate"}`}>{part.status}</span>}</td><td>{formatDate(job.dueDate)}</td>{detailed&&<td><span className="part-label">PART</span></td>}<td className="time-here-column">{formatTrackedTime(part.updatedAt,settings,job.overtime)}</td>{actionsVisible?<td className="actions-cell">{onPrintPart&&<button className="barcode-action" onClick={()=>onPrintPart(job,part)}>▥ Reprint</button>}</td>:collapsibleActions&&actionsAvailable?<td className="actions-closed-cell"/>:null}</tr>)}</Fragment>
  })}</tbody></table>{!jobs.length&&<div className="empty">No matching active jobs.</div>}</div>
}

function ScanList({scans,detailed=false}:{scans:ScanEvent[];detailed?:boolean}) { return <div className="scan-list">{scans.map(scan=><div className="scan-item" key={scan.id}><span className="scan-check">✓</span><div><b>Job {scan.jobNumber}</b><small>{scan.statusName?`Changed to ${scan.statusName} in ${scan.departmentName}`:`Moved to ${scan.departmentName}`}{detailed?` · ${scan.type}`:""}</small></div><time>{timeAgo(scan.timestamp)}</time></div>)}</div> }

function SplitJobDialog({job,onClose,onSave}:{job:Job;onClose:()=>void;onSave:(parts:Array<Pick<JobPart,"name"|"description"|"quantity">>)=>void}) {
  const [parts,setParts]=useState([{name:"Part A",description:"",quantity:""},{name:"Part B",description:"",quantity:""}]);
  const update=(index:number,field:"name"|"description"|"quantity",value:string)=>setParts(current=>current.map((part,partIndex)=>partIndex===index?{...part,[field]:value}:part));
  const addPart=()=>setParts(current=>current.length>=26?current:[...current,{name:`Part ${String.fromCharCode(65+current.length)}`,description:"",quantity:""}]);
  return <div className="job-editor-overlay" role="dialog" aria-modal="true" aria-label={`Split job ${job.jobNumber}`}><form className="job-editor split-job-dialog" onSubmit={event=>{event.preventDefault();onSave(parts)}}><div className="editor-head"><div><p className="eyebrow">OPTIONAL MULTI-PART TRACKING</p><h2>Split Job {job.jobNumber}</h2><p>Create one barcode for each physical portion that will move independently.</p></div><button type="button" aria-label="Close split job" onClick={onClose}>×</button></div><div className="split-guidance"><b>The original job remains the parent record.</b><span>Once split, employees scan the individual part labels—not the original job barcode.</span></div><div className="split-parts">{parts.map((part,index)=><div className="split-part-card" key={index}><div className="split-part-heading"><span>{job.jobNumber}-{String.fromCharCode(65+index)}</span>{parts.length>2&&<button type="button" onClick={()=>setParts(current=>current.filter((_,partIndex)=>partIndex!==index))}>Remove</button>}</div><label><span>Part name *</span><input required value={part.name} onChange={event=>update(index,"name",event.target.value)} placeholder="e.g. Routed panels"/></label><label><span>Description</span><input value={part.description} onChange={event=>update(index,"description",event.target.value)} placeholder="What physically belongs with this part?"/></label><label><span>Quantity</span><input value={part.quantity} onChange={event=>update(index,"quantity",event.target.value)} placeholder="Optional"/></label></div>)}</div><button type="button" className="add-part-button" onClick={addPart}>+ Add another part</button><div className="editor-actions"><span className="split-note">You can reprint every part label from the expanded job row.</span><div><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary">Create Parts</button></div></div></form></div>
}

function JobEditor({job,departments,statuses,canChangeSchedule,onClose,onSave,onPrint}:{job:Job;departments:Department[];statuses:StatusDefinition[];canChangeSchedule:boolean;onClose:()=>void;onSave:(original:Job,updated:Job,minutesHere:number)=>void;onPrint:()=>void}) {
  const [draft,setDraft]=useState(job);
  const initialMinutes=trackedMinutes(job.updatedAt,job.overtime);
  const [minutesHere,setMinutesHere]=useState(initialMinutes);
  const change=(field:keyof Job,value:string)=>setDraft(current=>({...current,[field]:value}));
  return <div className="job-editor-overlay" role="dialog" aria-modal="true" aria-label={`Review job ${job.jobNumber}`}><form className="job-editor" onSubmit={event=>{event.preventDefault();onSave(job,draft,minutesHere)}}><div className="editor-head"><div><p className="eyebrow">JOB RECORD & MANUAL OVERRIDE</p><h2>Review Job {job.jobNumber}</h2><p>Changes made here override the current production record.</p></div><button type="button" aria-label="Close job record" onClick={onClose}>×</button></div>{job.parts?.length&&<div className="split-guidance"><b>This job has {job.parts.length} independently tracked parts.</b><span>Change part locations and statuses from the expanded Active Jobs row.</span></div>}<div className="editor-grid"><label><span>Job number</span><input required value={draft.jobNumber} onChange={e=>change("jobNumber",e.target.value.toUpperCase())}/></label><label><span>Customer</span><input required value={draft.customer} onChange={e=>change("customer",e.target.value)}/></label><label className="wide"><span>Description</span><textarea required rows={2} value={draft.description} onChange={e=>change("description",e.target.value)}/></label><label><span>Location</span><select disabled={Boolean(job.parts?.length)} value={draft.currentDepartmentId} onChange={e=>change("currentDepartmentId",e.target.value)}><option value="">Not started</option>{departments.filter(item=>item.enabled).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>Status</span><select disabled={Boolean(job.parts?.length)} value={draft.status} onChange={e=>change("status",e.target.value)}>{statuses.filter(item=>item.enabled||item.name===draft.status).sort((a,b)=>a.order-b.order).map(item=><option key={item.id}>{item.name}</option>)}</select></label><label><span>Due date</span>{canChangeSchedule?<CalendarDatePicker value={draft.dueDate} onChange={value=>change("dueDate",value)}/>:<div className="schedule-readonly">{formatDate(draft.dueDate)}<small>Standard access cannot change dates.</small></div>}</label><label><span>Priority</span><select value={draft.priority} onChange={e=>change("priority",e.target.value)}><option>Standard</option><option>Rush</option><option>Critical</option></select></label><label><span>Time tracking</span><select disabled={!canChangeSchedule} value={draft.overtime?"overtime":"standard"} onChange={e=>setDraft(current=>({...current,overtime:e.target.value==="overtime"}))}><option value="standard">Standard business schedule</option><option value="overtime">Overtime — count continuously</option></select><small>{canChangeSchedule?"Overtime includes evenings, nights, and weekends.":"Standard access cannot change time tracking."}</small></label><label><span>Time in current location</span><div className="time-input"><input type="number" min="0" disabled={Boolean(job.parts?.length)||!canChangeSchedule} value={minutesHere} onChange={e=>setMinutesHere(Number(e.target.value))}/><b>minutes</b></div><small>{!canChangeSchedule?"Standard access cannot change the Time Here clock.":job.parts?.length?"Each part maintains its own Time Here clock.":"Adjusting this changes the “Time Here” clock."}</small></label><label className="wide"><span>Production notes</span><textarea rows={3} value={draft.notes} onChange={e=>change("notes",e.target.value)}/></label></div><div className="editor-summary"><span><b>Created</b>{new Date(job.createdAt).toLocaleString()}</span><span><b>Last movement</b>{new Date(job.updatedAt).toLocaleString()}</span><span><b>Route steps</b>{job.route.length}</span></div><div className="editor-actions">{!job.parts?.length?<button type="button" className="secondary" onClick={onPrint}>▥ Reprint Barcode</button>:<span/>}<div><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary">Save Manual Changes</button></div></div></form></div>
}

function StatusPrintSheet({statuses,onClose,onPrint}:{statuses:StatusDefinition[];onClose:()=>void;onPrint:()=>void}) { return <div className="status-sheet-overlay" role="dialog" aria-modal="true"><div className="status-sheet-modal"><div className="reprint-head"><div><p className="eyebrow">LAMINATED STATION COMMANDS</p><h2>Status barcode sheet</h2></div><button onClick={onClose}>×</button></div><div className="status-print-sheet"><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><h1>PRODUCTION STATUS COMMANDS</h1><p>Scan a status first, then scan one job within 15 seconds.</p><div className="status-label-grid">{statuses.filter(item=>item.enabled).sort((a,b)=>a.order-b.order).map(status=><div className="status-label" key={status.id} style={{borderTopColor:status.color}}><strong>{status.name}</strong><Code128 value={`STATUS:${status.code}`}/><small>STATUS:{status.code}</small></div>)}</div></div><div className="reprint-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" onClick={onPrint}>Print Status Barcodes</button></div></div></div> }

function ProductionPortalAdminCard() {
  const [copied,setCopied]=useState(false);
  const portalUrl=`${window.location.origin}${window.location.pathname}?view=production`;
  const copyLink=async()=>{
    try {
      if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(portalUrl);
      else {const input=document.createElement("textarea");input.value=portalUrl;input.style.position="fixed";input.style.opacity="0";document.body.appendChild(input);input.select();document.execCommand("copy");input.remove()}
      setCopied(true);window.setTimeout(()=>setCopied(false),2000);
    } catch {setCopied(false)}
  };
  return <section className="panel viewer-admin-card production-viewer-admin-card"><div className="viewer-admin-icon production" aria-hidden="true"><span>✎</span></div><div className="viewer-admin-copy"><p className="eyebrow">SECURE MOBILE PRODUCTION ACCESS</p><h2>Production Floor Portal</h2><p>A phone-friendly production and scanner view for authorized employees. Staff can scan jobs, filter the live workload, update location and status, and add shared production notes.</p><div className="viewer-link-row"><input aria-label="Production floor portal link" readOnly value={portalUrl}/><button type="button" className="secondary" onClick={copyLink}>{copied?"✓ Copied":"Copy link"}</button><a className="primary" href={portalUrl} target="_blank" rel="noreferrer"><span>Open portal</span><svg className="viewer-open-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 5 11"/></svg></a></div><div className="viewer-local-warning secure"><b>Employee sign-in required</b><span>Production Floor users enter the employee name and passcode assigned by a Super Admin.</span></div></div></section>;
}

function ViewerPortalAdminCard() {
  const [copied,setCopied]=useState(false);
  const portalUrl=`${window.location.origin}${window.location.pathname}?view=portal`;
  const copyLink=async()=>{
    try {
      if(navigator.clipboard?.writeText) await navigator.clipboard.writeText(portalUrl);
      else {
        const input=document.createElement("textarea");
        input.value=portalUrl;
        input.style.position="fixed";
        input.style.opacity="0";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      setCopied(true);
      window.setTimeout(()=>setCopied(false),2000);
    } catch { setCopied(false); }
  };
  return <section className="panel viewer-admin-card"><div className="viewer-admin-icon" aria-hidden="true"><span>◉</span></div><div className="viewer-admin-copy"><p className="eyebrow">PUBLIC READ-ONLY ACCESS</p><h2>Sales & Project Management Viewer</h2><p>A clean viewing portal with search, sorting, and views grouped by department, customer, status, or priority. It contains no edit, scanner, barcode, production-note, or administration controls.</p><div className="viewer-link-row"><input aria-label="Read-only portal link" readOnly value={portalUrl}/><button type="button" className="secondary" onClick={copyLink}>{copied?"✓ Copied":"Copy link"}</button><a className="primary" href={portalUrl} target="_blank" rel="noreferrer"><span>Open viewer</span><svg className="viewer-open-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 5 11"/></svg></a></div><div className="viewer-local-warning"><b>No login required</b><span>Anyone with this link can view the live production fields shown in the portal. They cannot change jobs or access PlantFlow administration.</span></div></div></section>;
}

function ReadyForBilling({jobs,statuses,autoDelete,onChangeAutoDelete,onApprove,onClear,onUpdate}:{jobs:Job[];statuses:StatusDefinition[];autoDelete:boolean;onChangeAutoDelete:(enabled:boolean)=>void;onApprove:(jobIds:string[])=>void;onClear:(jobIds:string[])=>void;onUpdate:(jobId:string,updates:Pick<Job,"billingState"|"billingNote">)=>void}) {
  const [open,setOpen]=useState(false);
  const [selected,setSelected]=useState<string[]>([]);
  const [noteJobId,setNoteJobId]=useState<string|null>(null);
  const [noteDraft,setNoteDraft]=useState("");
  const [stateFilter,setStateFilter]=useState<"all"|"awaiting"|"approved"|"hold">("all");
  const ready=jobs.filter(job=>jobIsComplete(job,statuses)).sort((a,b)=>(b.completedAt||b.updatedAt).localeCompare(a.completedAt||a.updatedAt));
  const approvedSelected=selected.filter(id=>{const job=ready.find(item=>item.id===id);return job?.billingState==="approved"||Boolean(job?.billingApprovedAt)});
  useEffect(()=>setSelected(current=>current.filter(id=>ready.some(job=>job.id===id))),[jobs]);
  const toggle=(id:string)=>setSelected(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id]);
  const editNote=(job:Job)=>{setNoteJobId(job.id);setNoteDraft(job.billingNote||"");};
  const closeNote=()=>{setNoteJobId(null);setNoteDraft("");};
  const billingState=(job:Job)=>job.billingState||(job.billingApprovedAt?"approved":"awaiting");
  const visibleReady=stateFilter==="all"?ready:ready.filter(job=>billingState(job)===stateFilter);
  const allSelected=visibleReady.length>0&&visibleReady.every(job=>selected.includes(job.id));
  return <section className={`panel ready-billing ${open?"open":""}`}>
    <button type="button" className="ready-billing-toggle" aria-expanded={open} onClick={()=>setOpen(current=>!current)}>
      <span className="ready-billing-folder" aria-hidden="true">▰</span>
      <span><b>Ready for Billing</b><small>Completed jobs stay here until approved and cleared</small></span>
      <em>{ready.length}</em><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
    </button>
    {open&&<div className="ready-billing-body">
      <div className="billing-retention-setting"><div><b>Automatically clear OK to Bill jobs after 30 days</b><span>{autoDelete?"On — the 30-day timer begins when a job is changed to OK to Bill. Awaiting Review and Billing Hold jobs stay here.":"Off — all billing records stay here until an administrator clears them manually."}</span></div><label className="switch" aria-label="Automatically clear OK to Bill jobs after 30 days"><input type="checkbox" checked={autoDelete} onChange={event=>onChangeAutoDelete(event.target.checked)}/><span/></label></div>
      <div className="ready-billing-note"><b>Billing workflow</b><span>Change each job’s billing state, add an internal billing note when needed, and clear approved records after billing. Permanent movement events remain in Job History.</span></div>
      {ready.length?<><div className="ready-billing-actions"><label><input type="checkbox" checked={allSelected} onChange={()=>setSelected(allSelected?selected.filter(id=>!visibleReady.some(job=>job.id===id)):[...new Set([...selected,...visibleReady.map(job=>job.id)])])}/> Select shown</label><select className="billing-filter" aria-label="Filter Ready for Billing by state" value={stateFilter} onChange={event=>setStateFilter(event.target.value as typeof stateFilter)}><option value="all">All billing states</option><option value="awaiting">Awaiting review</option><option value="approved">OK to bill</option><option value="hold">Billing hold</option></select><span>{selected.length} selected</span><button type="button" className="secondary" disabled={!selected.length} onClick={()=>onApprove(selected)}>Mark selected OK to bill</button><button type="button" className="billing-clear-button" disabled={!approvedSelected.length} onClick={()=>{onClear(approvedSelected);setSelected(current=>current.filter(id=>!approvedSelected.includes(id)))}}>Clear approved from folder</button></div>{visibleReady.length?<div className="ready-billing-table-wrap"><table className="ready-billing-table"><thead><tr><th/><th>Job</th><th>Customer / Description</th><th>Completed</th><th>Priority</th><th>Billing state</th><th>Note</th></tr></thead><tbody>{visibleReady.map(job=><Fragment key={job.id}><tr><td><input type="checkbox" checked={selected.includes(job.id)} onChange={()=>toggle(job.id)} aria-label={`Select job ${job.jobNumber}`}/></td><td><b>{job.jobNumber}</b></td><td><b>{job.customer}</b><small>{job.description}</small></td><td>{new Date(job.completedAt||job.updatedAt).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}</td><td><span className={`priority-text ${job.priority.toLowerCase()}`}>{job.priority}</span></td><td><select className={`billing-state-select ${billingState(job)}`} aria-label={`Billing state for job ${job.jobNumber}`} value={billingState(job)} onChange={event=>onUpdate(job.id,{billingState:event.target.value as Job["billingState"],billingNote:job.billingNote||""})}><option value="awaiting">Awaiting review</option><option value="approved">OK to bill</option><option value="hold">Billing hold</option></select></td><td><button type="button" className={`billing-note-button ${job.billingNote?"has-note":""}`} onClick={()=>noteJobId===job.id?closeNote():editNote(job)}>{job.billingNote?"Edit note":"Add note"}</button></td></tr>{noteJobId===job.id&&<tr className="billing-note-row"><td colSpan={7}><div className="billing-note-editor"><label><span>Billing note for Job {job.jobNumber}</span><textarea autoFocus rows={3} maxLength={500} value={noteDraft} onChange={event=>setNoteDraft(event.target.value)} placeholder="Add a billing detail, PO reminder, exception, or follow-up…"/></label><div><small>{noteDraft.length} / 500</small><button type="button" className="secondary" onClick={closeNote}>Cancel</button><button type="button" className="primary" onClick={()=>{onUpdate(job.id,{billingState:billingState(job),billingNote:noteDraft});closeNote();}}>Save note</button></div></div></td></tr>}</Fragment>)}</tbody></table></div>:<div className="ready-billing-filter-empty">No jobs match this billing state.</div>}</>:<div className="ready-billing-empty"><b>No completed jobs are waiting for billing.</b><span>Jobs appear here automatically when their status changes to Complete.</span></div>}
    </div>}
  </section>;
}

function ReportsBackupPanel({onReport,onBackup}:{onReport:(type:ReportType)=>void;onBackup:()=>void}) {
  return <section className="panel reports-backup"><div className="panel-head"><div><h2>Management reports</h2><p>Generate compact, shareable production summaries for daily meetings and management review.</p></div></div><div className="report-cards featured-report"><button className="daily-card" onClick={()=>onReport("daily")}><span>★</span><div><b>Daily Production Brief</b><small>A meeting-ready overview of today, the coming week, department workload, priority jobs, and management talking points.</small></div><em>Featured PDF →</em></button></div><div className="supporting-reports"><div className="report-section-heading"><h3>Supporting reports</h3><p>Use these when you need a closer look at a particular part of production.</p></div><div className="report-cards"><button onClick={()=>onReport("snapshot")}><span>01</span><div><b>Executive Snapshot</b><small>Active workload, priorities, due-date risk, departments, and statuses.</small></div><em>PDF →</em></button><button onClick={()=>onReport("workload")}><span>02</span><div><b>Department Workload</b><small>Job counts, average current dwell time, and the longest-waiting job by department.</small></div><em>PDF →</em></button><button onClick={()=>onReport("risks")}><span>03</span><div><b>Risks & Exceptions</b><small>Overdue, due soon, on hold, waiting for materials, rework, rush, and critical jobs.</small></div><em>PDF →</em></button></div></div><p className="report-note">PDF buttons open a print-ready report. Choose “Save as PDF” in the print window for a small file suitable for email or management sharing.</p><div className="backup-zone"><div className="backup-zone-heading"><div><p className="eyebrow">DATA PROTECTION</p><h3>Emergency backup</h3><small>This download is a complete operational backup, separate from the management reports above.</small></div><span>Complete sortable job list</span></div><div className="report-cards backup-grid"><button className="backup-card" onClick={onBackup}><span>↓</span><div><b>Download Emergency Excel Backup</b><small>Opens directly to every job in a sortable, filterable Excel table; complete backup fields and supporting records are included.</small></div><em>Download .XLSX →</em></button></div></div></section>;
}

function ManagementReport({type,state,onClose,onPrint}:{type:ReportType;state:typeof seedState;onClose:()=>void;onPrint:()=>void}) {
  if (type === "daily") return <DailyBriefReport state={state} onClose={onClose} onPrint={onPrint}/>;
  const departmentName=(id:string)=>state.departments.find(item=>item.id===id)?.name||"Not started";
  const active=state.jobs.filter(job=>!jobIsClosed(job,state.statuses));
  const overdue=active.filter(job=>job.dueDate<localDateValue());
  const dueSoon=active.filter(job=>job.dueDate>=localDateValue()&&job.dueDate<=localDateValue(2));
  const risks=active.filter(job=>job.dueDate<=localDateValue(2)||job.priority!=="Standard"||["On Hold","Waiting for Materials","Rework"].includes(job.status)).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  const departmentRows=state.departments.filter(item=>item.enabled).map(department=>{const jobs=active.filter(job=>job.currentDepartmentId===department.id);const minutes=jobs.map(job=>trackedMinutes(job.updatedAt,job.overtime));return {name:department.name,count:jobs.length,average:jobs.length?Math.round(minutes.reduce((a,b)=>a+b,0)/jobs.length):0,longest:jobs.length?Math.max(...minutes):0}}).filter(row=>row.count>0);
  const statusRows=state.statuses.map(status=>({name:status.name,count:active.filter(job=>job.status===status.name).length})).filter(row=>row.count>0);
  const title=type==="snapshot"?"Executive Production Snapshot":type==="workload"?"Department Workload & Dwell Time":"Production Risks & Exceptions";
  const duration=(minutes:number)=>formatTrackedMinutes(minutes,state.settings);
  return <div className="report-overlay" role="dialog" aria-modal="true"><div className="report-modal"><div className="reprint-head"><div><p className="eyebrow">MANAGEMENT REPORT</p><h2>{title}</h2></div><button onClick={onClose}>×</button></div><article className="management-report"><header><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><div><h1>{title}</h1><p>PlantFlow · Generated {new Date().toLocaleString()}</p></div></header>{type==="snapshot"&&<><div className="report-metrics"><span><b>{active.length}</b>Active jobs</span><span><b>{overdue.length}</b>Overdue</span><span><b>{dueSoon.length}</b>Due within 2 days</span><span><b>{active.filter(job=>job.priority!=="Standard").length}</b>Rush / critical</span></div><div className="report-columns"><ReportTable title="Jobs by department" headers={["Department","Jobs","Share"]} rows={departmentRows.map(row=>[row.name,row.count,`${active.length?Math.round(row.count/active.length*100):0}%`])}/><ReportTable title="Jobs by status" headers={["Status","Jobs","Share"]} rows={statusRows.map(row=>[row.name,row.count,`${active.length?Math.round(row.count/active.length*100):0}%`])}/></div></>}{type==="workload"&&<ReportTable title="Current department workload" headers={["Department","Active jobs","Average time here","Longest time here"]} rows={departmentRows.map(row=>[row.name,row.count,duration(row.average),duration(row.longest)])}/>} {type==="risks"&&<ReportTable title={`${risks.length} jobs requiring attention`} headers={["Job","Customer","Department","Status","Priority","Due"]} rows={risks.map(job=>[job.jobNumber,job.customer,departmentName(job.currentDepartmentId),job.status,job.priority,formatDate(job.dueDate)])}/>}<footer>Internal production report · Source: shared PlantFlow data</footer></article><div className="reprint-actions"><button className="secondary" onClick={onClose}>Close</button><button className="primary" onClick={onPrint}>Print / Save as PDF</button></div></div></div>;
}

function DailyBriefReport({state,onClose,onPrint}:{state:typeof seedState;onClose:()=>void;onPrint:()=>void}) {
  const today=localDateValue();
  const reportDate=new Date().toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric",year:"numeric"});
  const weekEnd=localDateValue(7);
  const departmentName=(id:string)=>state.departments.find(item=>item.id===id)?.name||"Not started";
  const active=state.jobs.filter(job=>!jobIsClosed(job,state.statuses));
  const dueToday=active.filter(job=>job.status!=="On Hold"&&job.dueDate===today);
  const overdue=active.filter(job=>job.status!=="On Hold"&&job.dueDate<today);
  const dueThisWeek=active.filter(job=>job.status!=="On Hold"&&job.dueDate>=today&&job.dueDate<=weekEnd).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  const attention=active.filter(job=>job.status!=="On Hold"&&(job.dueDate<=localDateValue(2)||job.priority!=="Standard"||["Waiting for Materials","Rework"].includes(job.status))).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  const completedToday=state.jobs.filter(job=>job.status==="Complete"&&job.updatedAt.slice(0,10)===today).length;
  const departmentRows=state.departments.filter(item=>item.enabled).map(department=>{const jobs=active.filter(job=>job.currentDepartmentId===department.id);const minutes=jobs.map(job=>trackedMinutes(job.updatedAt,job.overtime));return {name:department.name,count:jobs.length,average:jobs.length?Math.round(minutes.reduce((a,b)=>a+b,0)/jobs.length):0,longest:jobs.length?Math.max(...minutes):0}}).filter(row=>row.count>0).sort((a,b)=>b.count-a.count);
  const duration=(minutes:number)=>formatTrackedMinutes(minutes,state.settings);
  const busiest=departmentRows[0];
  const slowest=[...departmentRows].sort((a,b)=>b.longest-a.longest)[0];
  const actionBlocked=active.filter(job=>["Waiting for Materials","Rework"].includes(job.status));
  const onHold=active.filter(job=>job.status==="On Hold").sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt));
  const talkingPoints=[overdue.length?`${overdue.length} overdue ${overdue.length===1?"job needs":"jobs need"} an owner and recovery plan.`:"No overdue active jobs.",busiest?`${busiest.name} has the largest current workload with ${busiest.count} ${busiest.count===1?"job":"jobs"}.`:"No department workload is currently recorded.",slowest?`${slowest.name} has the longest current dwell time at ${duration(slowest.longest)}.`:"No dwell-time exceptions are currently recorded.",actionBlocked.length?`${actionBlocked.length} ${actionBlocked.length===1?"job needs":"jobs need"} action for materials or rework.`:"No material or rework issues need action.",onHold.length?`${onHold.length} on-hold ${onHold.length===1?"job is":"jobs are"} listed for awareness at the end of this brief.`:"No jobs are currently on hold."];
  const attentionJobs=attention.slice(0,12);
  const outlookJobs=dueThisWeek.slice(0,12);
  const jobTone=(job:Job)=>[
    job.dueDate<today?"report-overdue":job.dueDate===today?"report-due-today":"",
    job.priority==="Critical"?"report-critical":job.priority==="Rush"?"report-rush":"",
  ].filter(Boolean).join(" ");
  return <div className="report-overlay" role="dialog" aria-modal="true"><div className="report-modal daily-report-modal"><div className="reprint-head"><div><p className="eyebrow">MANAGEMENT REPORT</p><h2>Daily Production Brief</h2></div><button onClick={onClose}>×</button></div><article className="management-report daily-brief"><header><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><div><h1>Daily Production Brief</h1><p className="brief-report-date">{reportDate}</p><p>Generated {new Date().toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</p></div></header><div className="report-metrics five"><span><b>{active.length}</b>Active</span><span className={dueToday.length?"metric-warning":""}><b>{dueToday.length}</b>Due today</span><span className={overdue.length?"metric-danger":""}><b>{overdue.length}</b>Overdue</span><span><b>{dueThisWeek.length}</b>Due in 7 days</span><span className="metric-success"><b>{completedToday}</b>Completed today</span></div><section className="brief-talking-points"><h3>Production manager talking points</h3><ul>{talkingPoints.map(point=><li key={point}>{point}</li>)}</ul></section>{actionBlocked.length>0&&<ReportTable title="Action needed this morning" headers={["Job","Customer","Department","Current issue"]} rows={actionBlocked.map(job=>[job.jobNumber,job.customer,departmentName(job.currentDepartmentId),job.status])}/>}<ReportTable title={`${attention.length} priority jobs requiring discussion`} headers={["Job","Customer","Department","Status","Priority","Due"]} rows={attentionJobs.map(job=>[job.jobNumber,job.customer,departmentName(job.currentDepartmentId),job.status,job.priority,formatDate(job.dueDate)])} rowClassName={(_,index)=>jobTone(attentionJobs[index])}/><div className="report-columns brief-columns"><ReportTable title="Department workload" headers={["Department","Jobs","Avg. time here","Longest"]} rows={departmentRows.map(row=>[row.name,row.count,duration(row.average),duration(row.longest)])}/><ReportTable title="Seven-day due outlook" headers={["Due","Job","Customer","Priority"]} rows={outlookJobs.map(job=>[formatDate(job.dueDate),job.jobNumber,job.customer,job.priority])} rowClassName={(_,index)=>jobTone(outlookJobs[index])}/></div>{onHold.length>0&&<div className="on-hold-section"><ReportTable title={`${onHold.length} on-hold ${onHold.length===1?"job":"jobs"} — monitoring only`} headers={["Job","Customer","Department","Due","Time on hold"]} rows={onHold.map(job=>[job.jobNumber,job.customer,departmentName(job.currentDepartmentId),formatDate(job.dueDate),formatTrackedTime(job.updatedAt,state.settings,job.overtime)])}/></div>}<footer>Internal production report · Source: shared PlantFlow data</footer></article><div className="reprint-actions"><button className="secondary" onClick={onClose}>Close</button><button className="primary" onClick={onPrint}>Print / Save as PDF</button></div></div></div>;
}

function ReportTable({title,headers,rows,rowClassName}:{title:string;headers:string[];rows:(string|number)[][];rowClassName?:(row:(string|number)[],index:number)=>string}) { return <section className="report-table"><h3>{title}</h3><table><thead><tr>{headers.map(header=><th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={index} className={rowClassName?.(row,index)||""}>{row.map((cell,cellIndex)=><td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table>{!rows.length&&<p>No matching records.</p>}</section> }

function ActiveJobDeleteAction({job,onDelete}:{job:Job;onDelete:(job:Job)=>void|Promise<void>}) {
  const [open,setOpen]=useState(false);
  const [confirmationText,setConfirmationText]=useState("");
  const requiredText=`DELETE ${job.jobNumber}`;
  return <div className="active-job-delete-action">
    {!open?<button type="button" onClick={()=>setOpen(true)}>Delete job permanently</button>:<div className="data-delete-confirmation" role="dialog" aria-modal="true" aria-label={`Confirm deleting job ${job.jobNumber}`}><div><b>Permanently delete Job {job.jobNumber}?</b><span>The job, its parts, and all movement history will be removed. The job number will be available for reuse.</span><label>Type <strong>{requiredText}</strong> to continue<input autoFocus value={confirmationText} onChange={event=>setConfirmationText(event.target.value)}/></label><div><button type="button" className="secondary" onClick={()=>{setOpen(false);setConfirmationText("");}}>Cancel</button><button type="button" className="danger-button" disabled={confirmationText!==requiredText} onClick={()=>void onDelete(job)}>Delete permanently</button></div></div></div>}
  </div>;
}

function DataMaintenancePanel({jobCount,onClearAllJobs}:{jobCount:number;onClearAllJobs:()=>void|Promise<void>}) {
  const [confirmationOpen,setConfirmationOpen]=useState(false);
  const [confirmationText,setConfirmationText]=useState("");
  const requiredText="DELETE ALL JOBS";
  const closeConfirmation=()=>{setConfirmationOpen(false);setConfirmationText("");};
  const confirmDeletion=async()=>{if(confirmationText!==requiredText)return;await onClearAllJobs();closeConfirmation();};
  return <section className="panel data-maintenance-panel">
    <div>
      <p className="eyebrow">DATA MAINTENANCE</p>
      <h2>Job records</h2>
      <p>Remove all jobs, parts, and movement history before launch. Departments, statuses, settings, and user accounts are preserved.</p>
    </div>
    <div className="data-maintenance-actions">
      <span>{jobCount} {jobCount===1?"job":"jobs"} currently stored</span>
      <button type="button" className="danger-button" disabled={!jobCount} onClick={()=>{setConfirmationText("");setConfirmationOpen(true);}}>Clear all job data</button>
    </div>
    {confirmationOpen&&<div className="data-delete-confirmation" role="dialog" aria-modal="true" aria-label="Confirm clearing all job data"><div><b>Permanently clear all job data?</b><span>Every job, job part, and movement record will be removed. Configuration and users remain.</span><label>Type <strong>{requiredText}</strong> to continue<input autoFocus value={confirmationText} onChange={event=>setConfirmationText(event.target.value)} /></label><div><button type="button" className="secondary" onClick={closeConfirmation}>Cancel</button><button type="button" className="danger-button" disabled={confirmationText!==requiredText} onClick={()=>void confirmDeletion()}>Delete permanently</button></div></div></div>}
  </section>;
}

function Admin({departments,statuses,jobs,settings,onChangeSettings,onSave,onSaveStatuses,onPrintStatuses,onReset}:{departments:Department[];statuses:StatusDefinition[];jobs:Job[];settings:AppSettings;onChangeSettings:(settings:AppSettings)=>void;onSave:(d:Department[])=>void;onSaveStatuses:(s:StatusDefinition[])=>void;onPrintStatuses:(s:StatusDefinition[])=>void;onReset:()=>void}) {
  const [draft,setDraft]=useState(departments);
  const [statusDraft,setStatusDraft]=useState(statuses);
  const [editorMessage,setEditorMessage]=useState("");
  useEffect(()=>setDraft(departments),[departments]);
  useEffect(()=>setStatusDraft(statuses),[statuses]);
  const update=(id:string,field:keyof Department,value:string|boolean)=>setDraft(draft.map(d=>d.id===id?{...d,[field]:value}:d));
  const updateStatus=(id:string,field:keyof StatusDefinition,value:string|boolean)=>setStatusDraft(current=>current.map(status=>status.id===id?{...status,[field]:value}:status));
  const addDepartment=()=>{
    const nextNumber=draft.length+1;
    setDraft(current=>[...current,{id:makeId(),name:"New Department",prefix:`DEPT${nextNumber}`,enabled:true,order:Math.max(0,...current.map(item=>item.order))+1}]);
    setEditorMessage("New department added. Update its name and scanner prefix, then save departments.");
  };
  const deleteDepartment=(department:Department)=>{
    const assigned=jobs.some(job=>job.currentDepartmentId===department.id||job.parts?.some(part=>part.currentDepartmentId===department.id));
    if(assigned){setEditorMessage(`${department.name} is currently assigned to one or more jobs. Move those jobs first, or disable the department instead.`);return;}
    if(!window.confirm(`Delete ${department.name} from the department list? Existing scan-history text will be preserved.`))return;
    setDraft(current=>current.filter(item=>item.id!==department.id));
    setEditorMessage(`${department.name} removed from the draft. Click Save departments to confirm.`);
  };
  const addStatus=()=>setStatusDraft(current=>[...current,{id:makeId(),name:"New Status",code:`STATUS_${current.length+1}`,enabled:true,order:current.length+1,color:"#64748b",closesJob:false}]);
  const deleteStatus=(status:StatusDefinition)=>{
    const assigned=jobs.some(job=>job.status===status.name||job.parts?.some(part=>part.status===status.name));
    if(assigned){setEditorMessage(`${status.name} is currently assigned to one or more jobs. Change those jobs first, or disable the status instead.`);return;}
    if(!window.confirm(`Delete the ${status.name} status and its barcode command?`))return;
    setStatusDraft(current=>current.filter(item=>item.id!==status.id));
    setEditorMessage(`${status.name} removed from the draft. Click Save statuses to confirm.`);
  };
  return <section className="admin-workspace">{editorMessage&&<div className="admin-editor-message" role="status"><span>{editorMessage}</span><button type="button" aria-label="Dismiss message" onClick={()=>setEditorMessage("")}>×</button></div>}<div className="admin-grid"><div className="panel"><div className="panel-head"><div><h2>Departments & scanner prefixes</h2><p>Add, rename, disable, or remove departments as your workflow develops.</p></div><div className="department-admin-actions"><button className="secondary" onClick={addDepartment}>+ Add department</button><button className="primary small" onClick={()=>onSave(draft)}>Save departments</button></div></div><div className="department-editor">{[...draft].sort((a,b)=>a.order-b.order).map(d=><div key={d.id}><span className="drag">⠿</span><input aria-label="Department name" value={d.name} onChange={e=>update(d.id,"name",e.target.value)}/><label className="prefix-input"><span>Prefix</span><input aria-label={`Scanner prefix for ${d.name}`} value={d.prefix} onChange={e=>update(d.id,"prefix",e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g,""))}/><b>|</b></label><label className="switch" aria-label={`${d.enabled?"Disable":"Enable"} ${d.name}`}><input type="checkbox" checked={d.enabled} onChange={e=>update(d.id,"enabled",e.target.checked)}/><span/></label><button type="button" className="editor-delete-button" onClick={()=>deleteDepartment(d)}>Delete</button></div>)}</div></div><aside className="panel settings-card"><h2>Pilot settings</h2><div className="setting time-display-setting"><div><b>Time Here display</b><small>Standard schedule: Monday–Friday, 8:00 AM–5:00 PM</small><div className="time-mode-options"><button type="button" className={settings.timeDisplayMode==="days"?"active":""} onClick={()=>onChangeSettings({...settings,timeDisplayMode:"days"})}>Business days</button><button type="button" className={settings.timeDisplayMode==="hours"?"active":""} onClick={()=>onChangeSettings({...settings,timeDisplayMode:"hours"})}>Business hours</button></div></div></div><div className="setting deadline-setting"><div><b>Deadline highlighting</b><small>Yellow within 2 days; red when overdue</small></div><label className="switch" aria-label="Toggle deadline highlighting"><input type="checkbox" checked={settings.deadlineHighlighting} onChange={e=>onChangeSettings({...settings,deadlineHighlighting:e.target.checked})}/><span/></label></div><div className="setting"><div><b>Status command window</b><small>Status applies to the next job from that department</small></div><span>15 sec</span></div><div className="setting"><div><b>Duplicate scan window</b><small>Ignore repeat scans for 30 seconds</small></div><span>30 sec</span></div><div className="setting"><div><b>Storage mode</b><small>Shared Firebase data</small></div><span>Cloud</span></div><hr/><button className="danger-button" onClick={onReset}>Restore sample data</button></aside></div><div className="panel status-admin"><div className="panel-head"><div><h2>Statuses & laminated barcode commands</h2><p>Add, edit, disable, or remove status commands. One barcode sheet can be posted at every station.</p></div><div className="status-admin-actions"><button className="secondary" onClick={addStatus}>+ Add status</button><button className="secondary" onClick={()=>onPrintStatuses(statusDraft)}>▥ Print barcode sheet</button><button className="primary" onClick={()=>onSaveStatuses(statusDraft)}>Save statuses</button></div></div><div className="status-editor-head"><span>Color</span><span>Status name</span><span>Barcode command</span><span>Closes job</span><span>Enabled</span><span>Print</span><span>Remove</span></div><div className="status-editor">{[...statusDraft].sort((a,b)=>a.order-b.order).map(status=><div key={status.id}><input type="color" value={status.color} onChange={e=>updateStatus(status.id,"color",e.target.value)}/><input value={status.name} onChange={e=>updateStatus(status.id,"name",e.target.value)}/><label className="status-code"><span>STATUS:</span><input value={status.code} onChange={e=>updateStatus(status.id,"code",e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g,""))}/></label><label className="check-label"><input type="checkbox" checked={status.closesJob} onChange={e=>updateStatus(status.id,"closesJob",e.target.checked)}/> Yes</label><label className="switch"><input type="checkbox" checked={status.enabled} onChange={e=>updateStatus(status.id,"enabled",e.target.checked)}/><span/></label><button className="barcode-action" onClick={()=>onPrintStatuses([status])}>▥ Print</button><button type="button" className="editor-delete-button" onClick={()=>deleteStatus(status)}>Delete</button></div>)}</div></div></section>
}
