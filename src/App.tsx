"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import JsBarcode from "jsbarcode";
import { dataService, Department, Job, ScanEvent, seedState, StatusDefinition } from "../lib/dataService";
import { parseScannerInput } from "../lib/scanner";
import worthHigginsLogo from "./assets/WHALogo_Horizontal.png";
import whaWhiteLogo from "./assets/WHA_White.png";

type Page = "dashboard" | "create" | "jobs" | "history" | "admin";
type Notice = { kind: "success" | "error" | "duplicate"; title: string; detail: string } | null;
type ReportType = "daily" | "snapshot" | "workload" | "risks";

const nav: { id: Page; label: string; icon: string }[] = [
  { id: "create", label: "Create Job", icon: "+" },
  { id: "jobs", label: "Active Jobs", icon: "≡" },
  { id: "dashboard", label: "Live Dashboard", icon: "⌂" },
  { id: "history", label: "Job History", icon: "↺" },
  { id: "admin", label: "Administration", icon: "⚙" },
];

const statusTone: Record<string, string> = {
  "Ready for Production": "slate", "In Production": "blue", "On Hold": "amber",
  "Waiting for Materials": "orange", Rework: "red", Complete: "green", Canceled: "slate",
};

function timeAgo(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
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

async function downloadExcelBackup(state: typeof seedState) {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PlantFlow Production Tracker";
  workbook.company = "Worth Higgins & Associates";
  workbook.created = new Date();
  workbook.modified = new Date();
  const departmentName = (id: string) => state.departments.find(item=>item.id===id)?.name || "Not started";
  const activeJobs = state.jobs.filter(job=>!state.statuses.find(status=>status.name===job.status)?.closesJob);
  const headerFill = "155F48";
  const lightFill = "F4F7F5";
  const addSheet = (name:string, headers:string[], rows:(string|number|Date)[][], widths:number[], wrapColumns:number[] = []) => {
    const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.addTable({
      name: `${name.replace(/[^A-Za-z0-9]/g,"")}Table`,
      ref: "A1",
      headerRow: true,
      totalsRow: false,
      style: { theme: "TableStyleMedium4", showRowStripes: true },
      columns: headers.map(header=>({name:header,filterButton:true})),
      rows,
    });
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

  const jobsSheet=addSheet("All Jobs",["Job Number","Customer","Description","Current Department","Status","Priority","Due Date","Created","Last Updated","Production Route","Notes","Record ID","Department ID","Route Department IDs"],state.jobs.map(job=>[job.jobNumber,job.customer,job.description,departmentName(job.currentDepartmentId),job.status,job.priority,new Date(`${job.dueDate}T12:00:00`),new Date(job.createdAt),new Date(job.updatedAt),job.route.map(departmentName).join(" → "),job.notes,job.id,job.currentDepartmentId,job.route.join("|")]),[15,24,38,22,22,13,14,21,21,46,44,38,22,42],[3,10,11,14]);
  jobsSheet.getColumn(7).numFmt="mmm d, yyyy";
  jobsSheet.getColumn(8).numFmt="mmm d, yyyy h:mm AM/PM";
  jobsSheet.getColumn(9).numFmt="mmm d, yyyy h:mm AM/PM";
  jobsSheet.getColumn(12).hidden=true;
  jobsSheet.getColumn(13).hidden=true;
  jobsSheet.getColumn(14).hidden=true;
  jobsSheet.getRow(1).height=29;
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
  addSheet("Settings",["Setting","Value"],[["Due-date row highlighting",state.settings.deadlineHighlighting?"Enabled":"Disabled"]],[30,22]);

  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer);
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
  const link = document.createElement("a");
  link.href=url; link.download=`PlantFlow_Emergency_Backup_${localDateValue()}.xlsx`; link.click();
  window.setTimeout(()=>URL.revokeObjectURL(url),1000);
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
  const [page, setPage] = useState<Page>("jobs");
  const [state, setState] = useState(seedState);
  const [notice, setNotice] = useState<Notice>(null);
  const [jobNumberInput, setJobNumberInput] = useState("");
  const [labelJobNumber, setLabelJobNumber] = useState("");
  const [jobDueDate, setJobDueDate] = useState(() => localDateValue(3));
  const [query, setQuery] = useState("");
  const [printJob, setPrintJob] = useState<Job | null>(null);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [groupBy, setGroupBy] = useState<"none" | "location" | "customer">("none");
  const [sortBy, setSortBy] = useState<"recent" | "due" | "priority" | "time" | "job" | "customer">("recent");
  const [jobControlsOpen, setJobControlsOpen] = useState(false);
  const [jobActionsOpen, setJobActionsOpen] = useState(false);
  const [jobsFullscreen, setJobsFullscreen] = useState(false);
  const [pendingStatuses, setPendingStatuses] = useState<Record<string,{statusId:string;expiresAt:number}>>({});
  const [statusPrint, setStatusPrint] = useState<StatusDefinition[] | null>(null);
  const [managementReport, setManagementReport] = useState<ReportType | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const scanBuffer = useRef("");
  const lastKeyAt = useRef(0);
  const titleBeforePrint = useRef("");
  const activeJobsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // Hydrate the device-local pilot data after the client mounts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(dataService.load());
    setSidebarCollapsed(window.localStorage.getItem("plantflow-sidebar-collapsed") === "true");
  }, []);
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
    const syncFullscreenState = () => setJobsFullscreen(document.fullscreenElement === activeJobsRef.current);
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);
  const persist = useCallback((next: typeof state) => { setState(next); dataService.save(next); }, []);

  const toggleActiveJobsFullscreen = async () => {
    try {
      if (document.fullscreenElement === activeJobsRef.current) await document.exitFullscreen();
      else await activeJobsRef.current?.requestFullscreen();
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
    const job = state.jobs.find(j => j.jobNumber.toUpperCase() === parsed.jobNumber);
    if (!job) { setNotice({ kind: "error", title: "Job not found", detail: `No active job matches ${parsed.jobNumber}.` }); return; }
    const currentStatus = state.statuses.find(item => item.name === job.status);
    if (currentStatus?.closesJob) { setNotice({ kind: "error", title: `Job is ${job.status.toLowerCase()}`, detail: "Reopen the job before scanning it again." }); return; }
    const pending = pendingStatuses[department.id] || pendingStatuses.__global__;
    const commandedStatus = pending && pending.expiresAt > Date.now() ? state.statuses.find(item=>item.id===pending.statusId&&item.enabled) : undefined;
    const normalStatus = state.statuses.find(item=>item.code==="IN_PRODUCTION") || state.statuses.find(item=>item.enabled&&!item.closesJob);
    if (pending) setPendingStatuses(current => Object.fromEntries(Object.entries(current).filter(([key])=>key!==department.id&&key!=="__global__")));
    const previous = state.scans[0];
    if (!commandedStatus && previous?.jobNumber === job.jobNumber && previous.departmentId === department.id && Date.now() - new Date(previous.timestamp).getTime() < 30000) {
      setNotice({ kind: "duplicate", title: "Scan already received", detail: `${job.jobNumber} is already in ${department.name}.` }); return;
    }
    const now = new Date().toISOString();
    const routeIndex = job.route.indexOf(department.id);
    const currentIndex = job.route.indexOf(job.currentDepartmentId);
    const event: ScanEvent = { id: crypto.randomUUID(), jobNumber: job.jobNumber, departmentId: department.id, departmentName: department.name, previousDepartmentId: job.currentDepartmentId, timestamp: now, type: commandedStatus ? "Status command" : routeIndex === currentIndex + 1 || currentIndex === -1 ? "Normal" : "Route exception", statusName: commandedStatus?.name };
    const nextStatus = commandedStatus?.name || normalStatus?.name || "In Production";
    const jobs = state.jobs.map(j => j.id === job.id ? { ...j, currentDepartmentId: department.id, status: nextStatus, updatedAt: now } : j);
    persist({ ...state, jobs, scans: [event, ...state.scans] });
    setNotice({ kind: "success", title: commandedStatus ? `${job.jobNumber} changed to ${commandedStatus.name}` : `${job.jobNumber} moved to ${department.name}`, detail: `${department.name} · ${job.customer} · ${new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` });
  }, [state, persist, pendingStatuses]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
  }, [processScan]);

  const departments = state.departments;
  const statuses = state.statuses;
  const deptName = (id: string) => departments.find(d => d.id === id)?.name || "Not started";
  const activeJobs = state.jobs.filter(job => !statuses.find(status=>status.name===job.status)?.closesJob);
  const filteredJobs = activeJobs.filter(j => `${j.jobNumber} ${j.customer} ${j.description}`.toLowerCase().includes(query.toLowerCase()));
  const organizedJobs = useMemo(() => {
    const priorityRank = { Critical: 0, Rush: 1, Standard: 2 };
    return [...filteredJobs].sort((a,b) => {
      if (sortBy === "due") return a.dueDate.localeCompare(b.dueDate);
      if (sortBy === "priority") return priorityRank[a.priority] - priorityRank[b.priority] || a.dueDate.localeCompare(b.dueDate);
      if (sortBy === "time") return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      if (sortBy === "job") return a.jobNumber.localeCompare(b.jobNumber, undefined, { numeric: true });
      if (sortBy === "customer") return a.customer.localeCompare(b.customer);
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [filteredJobs, sortBy]);
  const jobGroups = useMemo(() => {
    if (groupBy === "none") return [{ key: "all", label: "All active jobs", jobs: organizedJobs }];
    const grouped = new Map<string, Job[]>();
    organizedJobs.forEach(job => {
      const key = groupBy === "location" ? (job.currentDepartmentId || "not-started") : job.customer;
      grouped.set(key, [...(grouped.get(key) || []), job]);
    });
    return [...grouped.entries()].map(([key,jobs]) => ({ key, label: groupBy === "location" ? deptName(key === "not-started" ? "" : key) : key, jobs }));
  }, [groupBy, organizedJobs, departments]);
  const today = new Date().toISOString().slice(0,10);

  const saveStatuses = (nextStatuses: StatusDefinition[]) => {
    const renameMap = new Map(statuses.map(oldStatus => [oldStatus.name,nextStatuses.find(item=>item.id===oldStatus.id)?.name||oldStatus.name]));
    persist({...state,statuses:nextStatuses,jobs:state.jobs.map(job=>({...job,status:renameMap.get(job.status)||job.status}))});
    setNotice({kind:"success",title:"Statuses updated",detail:"Status names, commands, colors, and availability were saved."});
  };

  const saveJobOverride = (original: Job, updated: Job, minutesHere: number) => {
    if (state.jobs.some(job => job.id !== original.id && job.jobNumber === updated.jobNumber)) {
      setNotice({ kind: "error", title: "Duplicate job number", detail: `${updated.jobNumber} is already being used.` });
      return;
    }
    const adjustedUpdatedAt = new Date(Date.now() - Math.max(0, minutesHere) * 60000).toISOString();
    const saved = { ...updated, updatedAt: adjustedUpdatedAt };
    let scans = state.scans.map(scan => scan.jobNumber === original.jobNumber ? { ...scan, jobNumber: saved.jobNumber } : scan);
    if (saved.currentDepartmentId !== original.currentDepartmentId) {
      const department = departments.find(item => item.id === saved.currentDepartmentId);
      scans = [{ id: crypto.randomUUID(), jobNumber: saved.jobNumber, departmentId: saved.currentDepartmentId, departmentName: department?.name || "Not started", previousDepartmentId: original.currentDepartmentId, timestamp: adjustedUpdatedAt, type: "Manual" as const }, ...scans];
    }
    persist({ ...state, jobs: state.jobs.map(job => job.id === original.id ? saved : job), scans });
    setSelectedJob(null);
    setNotice({ kind: "success", title: `Job ${saved.jobNumber} updated`, detail: "Manual changes were saved and the job record was refreshed." });
  };

  const updateJobInline = (job: Job, field: "location" | "status", value: string) => {
    if ((field === "location" && value === job.currentDepartmentId) || (field === "status" && value === job.status)) return;
    const now = new Date().toISOString();
    const departmentId = field === "location" ? value : job.currentDepartmentId;
    const departmentName = deptName(departmentId);
    const statusName = field === "status" ? value : undefined;
    const updatedJob: Job = {
      ...job,
      currentDepartmentId: departmentId,
      status: statusName || job.status,
      updatedAt: field === "location" ? now : job.updatedAt,
    };
    const event: ScanEvent = {
      id: crypto.randomUUID(),
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

  const createJob = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const jobNumber = String(form.get("jobNumber") || "").trim();
    if (state.jobs.some(j => j.jobNumber === jobNumber)) { setNotice({ kind: "error", title: "Duplicate job number", detail: `${jobNumber} already exists.` }); return; }
    const now = new Date().toISOString();
    const route = departments.filter(d => d.enabled && form.get(`route-${d.id}`)).map(d => d.id);
    const job: Job = { id: crypto.randomUUID(), jobNumber, customer: String(form.get("customer")), description: String(form.get("description")), dueDate: String(form.get("dueDate")), priority: String(form.get("priority")) as Job["priority"], status: statuses.find(item=>item.code==="READY")?.name||"Ready for Production", currentDepartmentId: "", route, notes: String(form.get("notes")), createdAt: now, updatedAt: now };
    persist({ ...state, jobs: [job, ...state.jobs] });
    setLabelJobNumber("");
    setJobNumberInput("");
    setJobDueDate(localDateValue(3));
    event.currentTarget.reset();
    setNotice({ kind: "success", title: `Job ${jobNumber} created`, detail: "The form is ready for the next job. Its barcode can be printed from Active Jobs or Job History." });
  };

  const toggleSidebar = () => setSidebarCollapsed(current => {
    const next = !current;
    window.localStorage.setItem("plantflow-sidebar-collapsed", String(next));
    return next;
  });

  return <div className={`app-shell ${sidebarCollapsed?"sidebar-collapsed":""}`}>
    <aside className="sidebar">
      <button className="sidebar-toggle" type="button" onClick={toggleSidebar} aria-label={sidebarCollapsed?"Expand navigation":"Collapse navigation"} title={sidebarCollapsed?"Expand menu":"Collapse menu"}>{sidebarCollapsed?"›":"‹"}</button>
      <div className="brand company-brand"><img className="full-brand-logo" src={worthHigginsLogo} alt="Worth Higgins & Associates" /><img className="compact-brand-logo" src={whaWhiteLogo} alt="WHA"/><div className="product-name"><strong>PlantFlow</strong><small>Production tracking</small></div></div>
      <nav>{nav.map(item => <button key={item.id} className={page===item.id?"active":""} onClick={()=>setPage(item.id)} title={sidebarCollapsed?item.label:undefined} aria-label={item.label}><span>{item.icon}</span><b>{item.label}</b></button>)}</nav>
      <div className="system-card"><span className="live-dot"/><div><strong>Scanner listener active</strong><small>Waiting for HID input</small></div></div>
    </aside>
    <main>
      <header><div><p className="eyebrow">SHOP FLOOR CONTROL</p><h1>{nav.find(n=>n.id===page)?.label}</h1></div><div className="header-actions"><span className="date-chip">{new Date().toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"})}</span><button className="primary small" onClick={()=>setPage("create")}>+ New job</button></div></header>
      {notice && <div className={`notice ${notice.kind}`}><span>{notice.kind==="success"?"✓":notice.kind==="duplicate"?"↺":"!"}</span><div><strong>{notice.title}</strong><small>{notice.detail}</small></div><button onClick={()=>setNotice(null)}>×</button></div>}

      {page === "dashboard" && <section>
        <div className="metrics">
          <Metric label="Active jobs" value={activeJobs.length} sub="Across production" />
          <Metric label="Due today" value={activeJobs.filter(j=>j.dueDate===today).length} sub="Needs attention" tone="amber" />
          <Metric label="Rush / critical" value={activeJobs.filter(j=>j.priority!=="Standard").length} sub="Priority work" tone="red" />
          <Metric label="Completed today" value={state.jobs.filter(j=>j.status==="Complete"&&j.updatedAt.slice(0,10)===today).length} sub="Production output" tone="green" />
        </div>
        <div className="dashboard-grid">
          <div className="panel span-2"><div className="panel-head"><div><h2>Active production</h2><p>Live location and timing for every open job</p></div><button className="text-button" onClick={()=>setPage("jobs")}>View all →</button></div><JobTable jobs={activeJobs.slice(0,6)} deptName={deptName} highlightDeadlines={state.settings.deadlineHighlighting} onPrint={setPrintJob} onOpen={setSelectedJob}/></div>
          <div className="panel"><div className="panel-head"><div><h2>Recent scans</h2><p>Latest shop-floor movements</p></div><span className="live-pill"><i/>LIVE</span></div><ScanList scans={state.scans.slice(0,5)} /></div>
        </div>
      </section>}

      {page === "create" && <section className="create-grid">
        <form className="panel job-form" onSubmit={createJob}><div className="panel-head"><div><h2>Create a production job</h2><p>Enter the job details and choose its expected route.</p></div></div>
          <div className="form-grid"><label><span>PACE job number *</span><input name="jobNumber" required placeholder="e.g. 590042" value={jobNumberInput} onChange={event=>{const value=event.target.value.toUpperCase();setJobNumberInput(value);setLabelJobNumber(value)}} /></label><label><span>Customer *</span><input name="customer" required placeholder="Customer name" /></label><label className="wide"><span>Job description *</span><input name="description" required placeholder="Project name or description" /></label><label><span>Production due date *</span><CalendarDatePicker name="dueDate" value={jobDueDate} min={localDateValue()} onChange={setJobDueDate}/></label><label><span>Priority</span><select name="priority" defaultValue="Standard"><option>Standard</option><option>Rush</option><option>Critical</option></select></label><label className="wide"><span>Production notes</span><textarea name="notes" rows={3} placeholder="Materials, finishing notes, or special handling" /></label></div>
          <fieldset><legend>Expected production route</legend><p>Select the departments this job is expected to visit. This list is editable later.</p><div className="route-options">{departments.filter(d=>d.enabled).map(d=><label key={d.id}><input type="checkbox" name={`route-${d.id}`} defaultChecked/><span className="route-num">{d.order}</span><div><b>{d.name}</b><small>{d.prefix}|</small></div></label>)}</div></fieldset>
          <div className="form-actions"><button type="reset" className="secondary" onClick={()=>{setJobNumberInput("");setLabelJobNumber("");setJobDueDate(localDateValue(3))}}>Clear form</button><button className="primary">Create job</button></div>
        </form>
        <div className="panel label-preview"><p className="eyebrow">LABEL PREVIEW</p><h2>Job barcode</h2><p>The barcode updates automatically as you enter the unique PACE job number.</p><div className="paper-label"><small>PRODUCTION JOB</small><strong>{labelJobNumber || "Enter job number"}</strong>{labelJobNumber ? <Code128 value={labelJobNumber}/> : <div className="barcode-placeholder">Barcode preview</div>}<p>Attach this label to the job jacket.</p></div><button className="secondary" disabled={!state.jobs.some(job=>job.jobNumber===labelJobNumber)} onClick={openCreatedJobLabel}>Print Barcode Label</button>{labelJobNumber&&!state.jobs.some(job=>job.jobNumber===labelJobNumber)&&<small className="save-before-print">Create the job first to enable printing.</small>}</div>
      </section>}

      {page === "jobs" && <section className="jobs-workspace" ref={activeJobsRef}>
        {jobGroups.map((group,index)=><section className={`panel job-group ${index===0&&jobControlsOpen?"controls-open":""}`} key={group.key}>
          <div className="group-heading"><div><h2>{group.label}</h2><p>{group.jobs.length} {group.jobs.length===1?"job":"jobs"}</p></div>{index===0&&<div className="jobs-toolbar-actions"><button type="button" className="fullscreen-toggle" onClick={toggleActiveJobsFullscreen}><span aria-hidden="true">{jobsFullscreen?"↙":"⛶"}</span>{jobsFullscreen?"Exit full screen":"Full screen"}</button><button type="button" className="controls-toggle" aria-expanded={jobControlsOpen} aria-controls="active-job-controls" onClick={()=>setJobControlsOpen(open=>!open)}><span>{jobControlsOpen?"Hide controls":"Search, organize & sort"}</span><b aria-hidden="true">⌄</b></button></div>}</div>
          {index===0&&jobControlsOpen&&<div className="job-controls" id="active-job-controls"><label><span>Search</span><input className="search" placeholder="Job, customer, or description" value={query} onChange={e=>setQuery(e.target.value)}/></label><label><span>Organize</span><select value={groupBy} onChange={e=>setGroupBy(e.target.value as typeof groupBy)}><option value="none">Overall view</option><option value="location">Group by department</option><option value="customer">Group by customer</option></select></label><label><span>Sort</span><select value={sortBy} onChange={e=>setSortBy(e.target.value as typeof sortBy)}><option value="recent">Most recently moved</option><option value="due">Due date — soonest</option><option value="priority">Priority — critical first</option><option value="time">Longest time here</option><option value="job">Job number</option><option value="customer">Customer name</option></select></label></div>}
          <JobTable jobs={group.jobs} deptName={deptName} detailed highlightDeadlines={state.settings.deadlineHighlighting} showActions={jobActionsOpen} collapsibleActions onToggleActions={()=>setJobActionsOpen(open=>!open)} onPrint={setPrintJob} onOpen={setSelectedJob} departments={departments} statuses={statuses} onInlineUpdate={updateJobInline}/>
        </section>)}
      </section>}

      {page === "history" && <section className="panel"><div className="panel-head"><div><h2>Permanent movement history</h2><p>Every scan is timestamped and retained.</p></div><span className="count-pill">{state.scans.length} events</span></div><div className="history-list">{state.scans.map(scan=>{const job=state.jobs.find(item=>item.jobNumber===scan.jobNumber);return <div className="history-row" key={scan.id}><div className="timeline-dot"/><time>{new Date(scan.timestamp).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}</time><strong>Job {scan.jobNumber}</strong><span>{scan.statusName?<>changed to <b>{scan.statusName}</b> in {scan.departmentName}</>:<>moved to <b>{scan.departmentName}</b></>}</span><em className={scan.type==="Normal"?"normal":"exception"}>{scan.type}</em>{job&&<button className="barcode-action" onClick={()=>setPrintJob(job)}>▥ Reprint</button>}</div>})}</div></section>}

      {page === "admin" && <><ReportsBackupPanel onReport={setManagementReport} onBackup={()=>downloadExcelBackup(state)}/><Admin departments={departments} statuses={statuses} deadlineHighlighting={state.settings.deadlineHighlighting} onToggleDeadlineHighlighting={(enabled)=>persist({...state,settings:{...state.settings,deadlineHighlighting:enabled}})} onSave={(next)=>persist({...state,departments:next})} onSaveStatuses={saveStatuses} onPrintStatuses={setStatusPrint} onReset={()=>{const next=dataService.reset();setState(next);setNotice({kind:"success",title:"Demo data restored",detail:"Placeholder departments, statuses, and sample jobs were reset."})}} /></>}
    </main>
    {printJob && <OverlayPortal target={jobsFullscreen?activeJobsRef.current:null}><div className="reprint-overlay" role="dialog" aria-modal="true" aria-label={`Reprint barcode for job ${printJob.jobNumber}`}><div className="reprint-modal"><div className="reprint-head"><div><p className="eyebrow">BARCODE REPRINT</p><h2>Job {printJob.jobNumber}</h2></div><button aria-label="Close barcode reprint" onClick={()=>setPrintJob(null)}>×</button></div><div className="reprint-sheet"><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><small>PRODUCTION JOB</small><strong>{printJob.jobNumber}</strong><Code128 value={printJob.jobNumber}/><div className="reprint-details"><b>{printJob.customer}</b><span>{printJob.description}</span></div></div><div className="reprint-actions"><button className="secondary" onClick={()=>setPrintJob(null)}>Cancel</button><button className="primary" onClick={printBarcode}>Print Barcode Label</button></div></div></div></OverlayPortal>}
    {selectedJob && <OverlayPortal target={jobsFullscreen?activeJobsRef.current:null}><JobEditor key={selectedJob.id} job={selectedJob} departments={departments} statuses={statuses} onClose={()=>setSelectedJob(null)} onSave={saveJobOverride} onPrint={()=>{setSelectedJob(null);setPrintJob(selectedJob)}} /></OverlayPortal>}
    {statusPrint && <StatusPrintSheet statuses={statusPrint} onClose={()=>setStatusPrint(null)} onPrint={printStatusBarcodes}/>} 
    {managementReport && <ManagementReport type={managementReport} state={state} onClose={()=>setManagementReport(null)} onPrint={printManagementReport}/>} 
  </div>;
}

function Metric({label,value,sub,tone="blue"}:{label:string;value:number;sub:string;tone?:string}) { return <div className={`metric ${tone}`}><div><p>{label}</p><strong>{value}</strong><small>{sub}</small></div><span>↗</span></div> }

function JobTable({jobs,deptName,detailed=false,highlightDeadlines=false,showActions=true,collapsibleActions=false,onToggleActions,onPrint,onOpen,departments,statuses,onInlineUpdate}:{jobs:Job[];deptName:(id:string)=>string;detailed?:boolean;highlightDeadlines?:boolean;showActions?:boolean;collapsibleActions?:boolean;onToggleActions?:()=>void;onPrint?:(job:Job)=>void;onOpen?:(job:Job)=>void;departments?:Department[];statuses?:StatusDefinition[];onInlineUpdate?:(job:Job,field:"location"|"status",value:string)=>void}) {
  const actionsAvailable=Boolean(onPrint||onOpen);
  const actionsVisible=showActions&&actionsAvailable;
  const inlineEditing=Boolean(onInlineUpdate&&departments&&statuses);
  return <div className="table-scroll"><table><thead><tr><th>Job</th><th>Customer / Description</th><th>Location</th><th>Status</th><th>Due</th>{detailed&&<th>Priority</th>}<th className="time-here-column">Time here</th>{collapsibleActions&&actionsAvailable?<th className={`actions-drawer-heading ${actionsVisible?"open":"closed"}`}><button type="button" className="table-actions-toggle" aria-label={actionsVisible?"Hide actions":"Show actions"} aria-expanded={actionsVisible} onClick={onToggleActions}><b aria-hidden="true">›</b><span className="actions-tooltip" role="tooltip">Actions</span></button></th>:actionsVisible&&<th className="actions-heading">Actions</th>}</tr></thead><tbody>{jobs.map(job=><tr key={job.id} className={`${onOpen?"reviewable-row ":""}${deadlineTone(job.dueDate,highlightDeadlines)}`.trim()} onDoubleClick={()=>onOpen?.(job)}><td><b className="job-num">{job.jobNumber}</b></td><td><b>{job.customer}</b><small>{job.description}</small></td><td>{inlineEditing?<select className="department-pill inline-pill-select" aria-label={`Change location for job ${job.jobNumber}`} title="Click to change location" value={job.currentDepartmentId} onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()} onChange={event=>onInlineUpdate?.(job,"location",event.target.value)}><option value="">Not started</option>{departments?.filter(item=>item.enabled).sort((a,b)=>a.order-b.order).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>:<span className="department-pill">{deptName(job.currentDepartmentId)}</span>}</td><td>{inlineEditing?<select className={`status-pill inline-pill-select ${statusTone[job.status]||"slate"}`} aria-label={`Change status for job ${job.jobNumber}`} title="Click to change status" value={job.status} onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()} onChange={event=>onInlineUpdate?.(job,"status",event.target.value)}>{statuses?.filter(item=>item.enabled).sort((a,b)=>a.order-b.order).map(item=><option key={item.id} value={item.name}>{item.name}</option>)}</select>:<span className={`status-pill ${statusTone[job.status]||"slate"}`}>{job.status}</span>}</td><td className={job.dueDate < localDateValue()?"overdue":""}>{formatDate(job.dueDate)}</td>{detailed&&<td><b className={`priority ${job.priority.toLowerCase()}`}>{job.priority}</b></td>}<td className="time-here-column">{timeAgo(job.updatedAt)}</td>{actionsVisible?<td className="actions-cell"><div className="row-actions">{onOpen&&<button className="review-action" onClick={()=>onOpen(job)}>Review</button>}{onPrint&&<button className="barcode-action" onClick={()=>onPrint(job)}>▥ Reprint</button>}</div></td>:collapsibleActions&&actionsAvailable?<td className="actions-closed-cell" aria-hidden="true"/>:null}</tr>)}</tbody></table>{!jobs.length&&<div className="empty">No matching active jobs.</div>}</div>
}

function ScanList({scans,detailed=false}:{scans:ScanEvent[];detailed?:boolean}) { return <div className="scan-list">{scans.map(scan=><div className="scan-item" key={scan.id}><span className="scan-check">✓</span><div><b>Job {scan.jobNumber}</b><small>{scan.statusName?`Changed to ${scan.statusName} in ${scan.departmentName}`:`Moved to ${scan.departmentName}`}{detailed?` · ${scan.type}`:""}</small></div><time>{timeAgo(scan.timestamp)}</time></div>)}</div> }

function JobEditor({job,departments,statuses,onClose,onSave,onPrint}:{job:Job;departments:Department[];statuses:StatusDefinition[];onClose:()=>void;onSave:(original:Job,updated:Job,minutesHere:number)=>void;onPrint:()=>void}) {
  const [draft,setDraft]=useState(job);
  const initialMinutes=Math.max(0,Math.floor((Date.now()-new Date(job.updatedAt).getTime())/60000));
  const [minutesHere,setMinutesHere]=useState(initialMinutes);
  const change=(field:keyof Job,value:string)=>setDraft(current=>({...current,[field]:value}));
  return <div className="job-editor-overlay" role="dialog" aria-modal="true" aria-label={`Review job ${job.jobNumber}`}><form className="job-editor" onSubmit={event=>{event.preventDefault();onSave(job,draft,minutesHere)}}><div className="editor-head"><div><p className="eyebrow">JOB RECORD & MANUAL OVERRIDE</p><h2>Review Job {job.jobNumber}</h2><p>Changes made here override the current production record.</p></div><button type="button" aria-label="Close job record" onClick={onClose}>×</button></div><div className="editor-grid"><label><span>Job number</span><input required value={draft.jobNumber} onChange={e=>change("jobNumber",e.target.value.toUpperCase())}/></label><label><span>Customer</span><input required value={draft.customer} onChange={e=>change("customer",e.target.value)}/></label><label className="wide"><span>Description</span><textarea required rows={2} value={draft.description} onChange={e=>change("description",e.target.value)}/></label><label><span>Location</span><select value={draft.currentDepartmentId} onChange={e=>change("currentDepartmentId",e.target.value)}><option value="">Not started</option>{departments.filter(item=>item.enabled).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>Status</span><select value={draft.status} onChange={e=>change("status",e.target.value)}>{statuses.filter(item=>item.enabled||item.name===draft.status).sort((a,b)=>a.order-b.order).map(item=><option key={item.id}>{item.name}</option>)}</select></label><label><span>Due date</span><CalendarDatePicker value={draft.dueDate} onChange={value=>change("dueDate",value)}/></label><label><span>Priority</span><select value={draft.priority} onChange={e=>change("priority",e.target.value)}><option>Standard</option><option>Rush</option><option>Critical</option></select></label><label><span>Time in current location</span><div className="time-input"><input type="number" min="0" value={minutesHere} onChange={e=>setMinutesHere(Number(e.target.value))}/><b>minutes</b></div><small>Adjusting this changes the “Time Here” clock.</small></label><label className="wide"><span>Production notes</span><textarea rows={3} value={draft.notes} onChange={e=>change("notes",e.target.value)}/></label></div><div className="editor-summary"><span><b>Created</b>{new Date(job.createdAt).toLocaleString()}</span><span><b>Last movement</b>{new Date(job.updatedAt).toLocaleString()}</span><span><b>Route steps</b>{job.route.length}</span></div><div className="editor-actions"><button type="button" className="secondary" onClick={onPrint}>▥ Reprint Barcode</button><div><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary">Save Manual Changes</button></div></div></form></div>
}

function StatusPrintSheet({statuses,onClose,onPrint}:{statuses:StatusDefinition[];onClose:()=>void;onPrint:()=>void}) { return <div className="status-sheet-overlay" role="dialog" aria-modal="true"><div className="status-sheet-modal"><div className="reprint-head"><div><p className="eyebrow">LAMINATED STATION COMMANDS</p><h2>Status barcode sheet</h2></div><button onClick={onClose}>×</button></div><div className="status-print-sheet"><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><h1>PRODUCTION STATUS COMMANDS</h1><p>Scan a status first, then scan one job within 15 seconds.</p><div className="status-label-grid">{statuses.filter(item=>item.enabled).sort((a,b)=>a.order-b.order).map(status=><div className="status-label" key={status.id} style={{borderTopColor:status.color}}><strong>{status.name}</strong><Code128 value={`STATUS:${status.code}`}/><small>STATUS:{status.code}</small></div>)}</div></div><div className="reprint-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" onClick={onPrint}>Print Status Barcodes</button></div></div></div> }

function ReportsBackupPanel({onReport,onBackup}:{onReport:(type:ReportType)=>void;onBackup:()=>void}) {
  return <section className="panel reports-backup"><div className="panel-head"><div><h2>Management reports</h2><p>Generate compact, shareable production summaries for daily meetings and management review.</p></div></div><div className="report-cards featured-report"><button className="daily-card" onClick={()=>onReport("daily")}><span>★</span><div><b>Daily Production Brief</b><small>A meeting-ready overview of today, the coming week, department workload, priority jobs, and management talking points.</small></div><em>Featured PDF →</em></button></div><div className="supporting-reports"><div className="report-section-heading"><h3>Supporting reports</h3><p>Use these when you need a closer look at a particular part of production.</p></div><div className="report-cards"><button onClick={()=>onReport("snapshot")}><span>01</span><div><b>Executive Snapshot</b><small>Active workload, priorities, due-date risk, departments, and statuses.</small></div><em>PDF →</em></button><button onClick={()=>onReport("workload")}><span>02</span><div><b>Department Workload</b><small>Job counts, average current dwell time, and the longest-waiting job by department.</small></div><em>PDF →</em></button><button onClick={()=>onReport("risks")}><span>03</span><div><b>Risks & Exceptions</b><small>Overdue, due soon, on hold, waiting for materials, rework, rush, and critical jobs.</small></div><em>PDF →</em></button></div></div><p className="report-note">PDF buttons open a print-ready report. Choose “Save as PDF” in the print window for a small file suitable for email or management sharing.</p><div className="backup-zone"><div className="backup-zone-heading"><div><p className="eyebrow">DATA PROTECTION</p><h3>Emergency backup</h3><small>This download is a complete operational backup, separate from the management reports above.</small></div><span>Complete sortable job list</span></div><div className="report-cards backup-grid"><button className="backup-card" onClick={onBackup}><span>↓</span><div><b>Download Emergency Excel Backup</b><small>Opens directly to every job in a sortable, filterable Excel table; complete backup fields and supporting records are included.</small></div><em>Download .XLSX →</em></button></div></div></section>;
}

function ManagementReport({type,state,onClose,onPrint}:{type:ReportType;state:typeof seedState;onClose:()=>void;onPrint:()=>void}) {
  if (type === "daily") return <DailyBriefReport state={state} onClose={onClose} onPrint={onPrint}/>;
  const departmentName=(id:string)=>state.departments.find(item=>item.id===id)?.name||"Not started";
  const active=state.jobs.filter(job=>!state.statuses.find(status=>status.name===job.status)?.closesJob);
  const overdue=active.filter(job=>job.dueDate<localDateValue());
  const dueSoon=active.filter(job=>job.dueDate>=localDateValue()&&job.dueDate<=localDateValue(2));
  const risks=active.filter(job=>job.dueDate<=localDateValue(2)||job.priority!=="Standard"||["On Hold","Waiting for Materials","Rework"].includes(job.status)).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  const departmentRows=state.departments.filter(item=>item.enabled).map(department=>{const jobs=active.filter(job=>job.currentDepartmentId===department.id);const minutes=jobs.map(job=>Math.max(0,Math.floor((Date.now()-new Date(job.updatedAt).getTime())/60000)));return {name:department.name,count:jobs.length,average:jobs.length?Math.round(minutes.reduce((a,b)=>a+b,0)/jobs.length):0,longest:jobs.length?Math.max(...minutes):0}}).filter(row=>row.count>0);
  const statusRows=state.statuses.map(status=>({name:status.name,count:active.filter(job=>job.status===status.name).length})).filter(row=>row.count>0);
  const title=type==="snapshot"?"Executive Production Snapshot":type==="workload"?"Department Workload & Dwell Time":"Production Risks & Exceptions";
  const duration=(minutes:number)=>minutes<60?`${minutes} min`:`${Math.floor(minutes/60)}h ${minutes%60}m`;
  return <div className="report-overlay" role="dialog" aria-modal="true"><div className="report-modal"><div className="reprint-head"><div><p className="eyebrow">MANAGEMENT REPORT</p><h2>{title}</h2></div><button onClick={onClose}>×</button></div><article className="management-report"><header><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><div><h1>{title}</h1><p>PlantFlow · Generated {new Date().toLocaleString()}</p></div></header>{type==="snapshot"&&<><div className="report-metrics"><span><b>{active.length}</b>Active jobs</span><span><b>{overdue.length}</b>Overdue</span><span><b>{dueSoon.length}</b>Due within 2 days</span><span><b>{active.filter(job=>job.priority!=="Standard").length}</b>Rush / critical</span></div><div className="report-columns"><ReportTable title="Jobs by department" headers={["Department","Jobs","Share"]} rows={departmentRows.map(row=>[row.name,row.count,`${active.length?Math.round(row.count/active.length*100):0}%`])}/><ReportTable title="Jobs by status" headers={["Status","Jobs","Share"]} rows={statusRows.map(row=>[row.name,row.count,`${active.length?Math.round(row.count/active.length*100):0}%`])}/></div></>}{type==="workload"&&<ReportTable title="Current department workload" headers={["Department","Active jobs","Average time here","Longest time here"]} rows={departmentRows.map(row=>[row.name,row.count,duration(row.average),duration(row.longest)])}/>} {type==="risks"&&<ReportTable title={`${risks.length} jobs requiring attention`} headers={["Job","Customer","Department","Status","Priority","Due"]} rows={risks.map(job=>[job.jobNumber,job.customer,departmentName(job.currentDepartmentId),job.status,job.priority,formatDate(job.dueDate)])}/>}<footer>Internal production report · Source: PlantFlow device-local data</footer></article><div className="reprint-actions"><button className="secondary" onClick={onClose}>Close</button><button className="primary" onClick={onPrint}>Print / Save as PDF</button></div></div></div>;
}

function DailyBriefReport({state,onClose,onPrint}:{state:typeof seedState;onClose:()=>void;onPrint:()=>void}) {
  const today=localDateValue();
  const reportDate=new Date().toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric",year:"numeric"});
  const weekEnd=localDateValue(7);
  const departmentName=(id:string)=>state.departments.find(item=>item.id===id)?.name||"Not started";
  const active=state.jobs.filter(job=>!state.statuses.find(status=>status.name===job.status)?.closesJob);
  const dueToday=active.filter(job=>job.status!=="On Hold"&&job.dueDate===today);
  const overdue=active.filter(job=>job.status!=="On Hold"&&job.dueDate<today);
  const dueThisWeek=active.filter(job=>job.status!=="On Hold"&&job.dueDate>=today&&job.dueDate<=weekEnd).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  const attention=active.filter(job=>job.status!=="On Hold"&&(job.dueDate<=localDateValue(2)||job.priority!=="Standard"||["Waiting for Materials","Rework"].includes(job.status))).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  const completedToday=state.jobs.filter(job=>job.status==="Complete"&&job.updatedAt.slice(0,10)===today).length;
  const departmentRows=state.departments.filter(item=>item.enabled).map(department=>{const jobs=active.filter(job=>job.currentDepartmentId===department.id);const minutes=jobs.map(job=>Math.max(0,Math.floor((Date.now()-new Date(job.updatedAt).getTime())/60000)));return {name:department.name,count:jobs.length,average:jobs.length?Math.round(minutes.reduce((a,b)=>a+b,0)/jobs.length):0,longest:jobs.length?Math.max(...minutes):0}}).filter(row=>row.count>0).sort((a,b)=>b.count-a.count);
  const duration=(minutes:number)=>minutes<60?`${minutes} min`:`${Math.floor(minutes/60)}h ${minutes%60}m`;
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
  return <div className="report-overlay" role="dialog" aria-modal="true"><div className="report-modal daily-report-modal"><div className="reprint-head"><div><p className="eyebrow">MANAGEMENT REPORT</p><h2>Daily Production Brief</h2></div><button onClick={onClose}>×</button></div><article className="management-report daily-brief"><header><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><div><h1>Daily Production Brief</h1><p className="brief-report-date">{reportDate}</p><p>Generated {new Date().toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</p></div></header><div className="report-metrics five"><span><b>{active.length}</b>Active</span><span className={dueToday.length?"metric-warning":""}><b>{dueToday.length}</b>Due today</span><span className={overdue.length?"metric-danger":""}><b>{overdue.length}</b>Overdue</span><span><b>{dueThisWeek.length}</b>Due in 7 days</span><span className="metric-success"><b>{completedToday}</b>Completed today</span></div><section className="brief-talking-points"><h3>Production manager talking points</h3><ul>{talkingPoints.map(point=><li key={point}>{point}</li>)}</ul></section>{actionBlocked.length>0&&<ReportTable title="Action needed this morning" headers={["Job","Customer","Department","Current issue"]} rows={actionBlocked.map(job=>[job.jobNumber,job.customer,departmentName(job.currentDepartmentId),job.status])}/>}<ReportTable title={`${attention.length} priority jobs requiring discussion`} headers={["Job","Customer","Department","Status","Priority","Due"]} rows={attentionJobs.map(job=>[job.jobNumber,job.customer,departmentName(job.currentDepartmentId),job.status,job.priority,formatDate(job.dueDate)])} rowClassName={(_,index)=>jobTone(attentionJobs[index])}/><div className="report-columns brief-columns"><ReportTable title="Department workload" headers={["Department","Jobs","Avg. time here","Longest"]} rows={departmentRows.map(row=>[row.name,row.count,duration(row.average),duration(row.longest)])}/><ReportTable title="Seven-day due outlook" headers={["Due","Job","Customer","Priority"]} rows={outlookJobs.map(job=>[formatDate(job.dueDate),job.jobNumber,job.customer,job.priority])} rowClassName={(_,index)=>jobTone(outlookJobs[index])}/></div>{onHold.length>0&&<div className="on-hold-section"><ReportTable title={`${onHold.length} on-hold ${onHold.length===1?"job":"jobs"} — monitoring only`} headers={["Job","Customer","Department","Due","Time on hold"]} rows={onHold.map(job=>[job.jobNumber,job.customer,departmentName(job.currentDepartmentId),formatDate(job.dueDate),timeAgo(job.updatedAt)])}/></div>}<footer>Internal production report · Source: PlantFlow device-local data</footer></article><div className="reprint-actions"><button className="secondary" onClick={onClose}>Close</button><button className="primary" onClick={onPrint}>Print / Save as PDF</button></div></div></div>;
}

function ReportTable({title,headers,rows,rowClassName}:{title:string;headers:string[];rows:(string|number)[][];rowClassName?:(row:(string|number)[],index:number)=>string}) { return <section className="report-table"><h3>{title}</h3><table><thead><tr>{headers.map(header=><th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={index} className={rowClassName?.(row,index)||""}>{row.map((cell,cellIndex)=><td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table>{!rows.length&&<p>No matching records.</p>}</section> }

function Admin({departments,statuses,deadlineHighlighting,onToggleDeadlineHighlighting,onSave,onSaveStatuses,onPrintStatuses,onReset}:{departments:Department[];statuses:StatusDefinition[];deadlineHighlighting:boolean;onToggleDeadlineHighlighting:(enabled:boolean)=>void;onSave:(d:Department[])=>void;onSaveStatuses:(s:StatusDefinition[])=>void;onPrintStatuses:(s:StatusDefinition[])=>void;onReset:()=>void}) {
  const [draft,setDraft]=useState(departments);
  const [statusDraft,setStatusDraft]=useState(statuses);
  const update=(id:string,field:keyof Department,value:string|boolean)=>setDraft(draft.map(d=>d.id===id?{...d,[field]:value}:d));
  const updateStatus=(id:string,field:keyof StatusDefinition,value:string|boolean)=>setStatusDraft(current=>current.map(status=>status.id===id?{...status,[field]:value}:status));
  const addStatus=()=>setStatusDraft(current=>[...current,{id:crypto.randomUUID(),name:"New Status",code:`STATUS_${current.length+1}`,enabled:true,order:current.length+1,color:"#64748b",closesJob:false}]);
  return <section className="admin-workspace"><div className="admin-grid"><div className="panel"><div className="panel-head"><div><h2>Departments & scanner prefixes</h2><p>Rename, disable, or change prefixes as your workflow develops.</p></div><button className="primary small" onClick={()=>onSave(draft)}>Save departments</button></div><div className="department-editor">{[...draft].sort((a,b)=>a.order-b.order).map(d=><div key={d.id}><span className="drag">⠿</span><input value={d.name} onChange={e=>update(d.id,"name",e.target.value)}/><label className="prefix-input"><span>Prefix</span><input value={d.prefix} onChange={e=>update(d.id,"prefix",e.target.value.toUpperCase().replace(/\|/g,""))}/><b>|</b></label><label className="switch"><input type="checkbox" checked={d.enabled} onChange={e=>update(d.id,"enabled",e.target.checked)}/><span/></label></div>)}</div></div><aside className="panel settings-card"><h2>Pilot settings</h2><div className="setting deadline-setting"><div><b>Deadline highlighting</b><small>Yellow within 2 days; red when overdue</small></div><label className="switch" aria-label="Toggle deadline highlighting"><input type="checkbox" checked={deadlineHighlighting} onChange={e=>onToggleDeadlineHighlighting(e.target.checked)}/><span/></label></div><div className="setting"><div><b>Status command window</b><small>Status applies to the next job from that department</small></div><span>15 sec</span></div><div className="setting"><div><b>Duplicate scan window</b><small>Ignore repeat scans for 30 seconds</small></div><span>30 sec</span></div><div className="setting"><div><b>Storage mode</b><small>Device-local pilot data</small></div><span>Local</span></div><hr/><button className="danger-button" onClick={onReset}>Restore sample data</button></aside></div><div className="panel status-admin"><div className="panel-head"><div><h2>Statuses & laminated barcode commands</h2><p>One status barcode can be printed and posted at every station. The scanner prefix identifies the department.</p></div><div className="status-admin-actions"><button className="secondary" onClick={addStatus}>+ Add status</button><button className="secondary" onClick={()=>onPrintStatuses(statusDraft)}>▥ Print barcode sheet</button><button className="primary" onClick={()=>onSaveStatuses(statusDraft)}>Save statuses</button></div></div><div className="status-editor-head"><span>Color</span><span>Status name</span><span>Barcode command</span><span>Closes job</span><span>Enabled</span><span>Print</span></div><div className="status-editor">{[...statusDraft].sort((a,b)=>a.order-b.order).map(status=><div key={status.id}><input type="color" value={status.color} onChange={e=>updateStatus(status.id,"color",e.target.value)}/><input value={status.name} onChange={e=>updateStatus(status.id,"name",e.target.value)}/><label className="status-code"><span>STATUS:</span><input value={status.code} onChange={e=>updateStatus(status.id,"code",e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g,""))}/></label><label className="check-label"><input type="checkbox" checked={status.closesJob} onChange={e=>updateStatus(status.id,"closesJob",e.target.checked)}/> Yes</label><label className="switch"><input type="checkbox" checked={status.enabled} onChange={e=>updateStatus(status.id,"enabled",e.target.checked)}/><span/></label><button className="barcode-action" onClick={()=>onPrintStatuses([status])}>▥ Print</button></div>)}</div></div></section>
}
