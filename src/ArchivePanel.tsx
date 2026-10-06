import { DepartmentHistory } from "./DepartmentHistory";
import type { ScanEvent } from "../lib/dataService";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ArchivedJob, ArchiveLoader, ArchiveSort } from "../lib/archiveTypes";

export function ArchivePanel({loadPage,revision=0,loadHistory,resumeHistory}:{loadPage:ArchiveLoader;revision?:number;loadHistory:(id:string)=>Promise<ScanEvent[]>;resumeHistory?:(id:string)=>Promise<void>}) {
  const [open,setOpen]=useState(false);
  return <section className="panel archive-panel"><button className="ready-billing-toggle" type="button" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><span className="ready-billing-folder">▰</span><span><b>Archive</b><small>Full job details preserved after billing. Open to load records.</small></span><span>{open?"Close":"Open archive"}</span></button>{open&&<ArchiveContents loadPage={loadPage} revision={revision} loadHistory={loadHistory} resumeHistory={resumeHistory}/>}</section>;
}

function ArchiveContents({loadPage,revision,loadHistory,resumeHistory}:{loadPage:ArchiveLoader;revision:number;loadHistory:(id:string)=>Promise<ScanEvent[]>;resumeHistory?:(id:string)=>Promise<void>}) {
  const [sort,setSort]=useState<ArchiveSort>("newest");
  const [records,setRecords]=useState<ArchivedJob[]>([]);
  const [cursor,setCursor]=useState<unknown>();
  const [hasMore,setHasMore]=useState(false);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [selected,setSelected]=useState<ArchivedJob|null>(null);
  const [reload,setReload]=useState(0);
  const selectedHistory = useCallback(() => selected ? loadHistory(selected.id) : Promise.resolve([]), [selected,loadHistory]);
  const [capturing,setCapturing]=useState(false);
  const [captureError,setCaptureError]=useState("");
  const generation=useRef(0);
  const busy=useRef(false);
  useEffect(()=>{
    const current=++generation.current;
    busy.current=true;setLoading(true);setError("");setRecords([]);setCursor(undefined);setHasMore(false);setSelected(null);
    loadPage(sort).then(page=>{if(current!==generation.current)return;setRecords(page.records);setCursor(page.cursor);setHasMore(page.hasMore);}).catch(reason=>{if(current===generation.current)setError(reason instanceof Error?reason.message:"Archive could not be loaded.");}).finally(()=>{if(current===generation.current){busy.current=false;setLoading(false);}});
    return ()=>{generation.current++;};
  },[sort,loadPage,revision,reload]);
  async function more(){
    if(busy.current||!hasMore)return;
    const current=generation.current;busy.current=true;setLoading(true);setError("");
    try{const page=await loadPage(sort,cursor);if(current!==generation.current)return;setRecords(items=>[...new Map([...items,...page.records].map(item=>[item.id,item])).values()]);setCursor(page.cursor);setHasMore(page.hasMore);}
    catch(reason){if(current===generation.current)setError(reason instanceof Error?reason.message:"Could not load the next page.");}
    finally{if(current===generation.current){busy.current=false;setLoading(false);}}
  }
  return <div className="archive-content"><div className="ready-billing-actions"><label>Sort archive <select aria-label="Sort archive" value={sort} onChange={event=>setSort(event.target.value as ArchiveSort)}><option value="newest">Archived newest first</option><option value="oldest">Archived oldest first</option><option value="job">Job number A–Z</option><option value="customer">Customer A–Z</option></select></label><span>{records.length} records loaded</span><button type="button" className="secondary" disabled={loading} onClick={()=>setReload(value=>value+1)}>Refresh archive</button></div>
    {error&&<div role="alert" className="archive-error">{error} <button type="button" onClick={()=>records.length?void more():setReload(value=>value+1)}>Retry</button></div>}
    {!!records.length&&<div className="ready-billing-table-wrap"><table className="ready-billing-table"><thead><tr><th>Job</th><th>Customer / Description</th><th>Archived</th><th>Details</th></tr></thead><tbody>{records.map(record=><tr key={record.id}><td><b>{record.job.jobNumber}</b>{record.historyStatus==="capturing"&&<small>History capture pending</small>}</td><td><b>{record.job.customer}</b><small>{record.job.description}</small></td><td>{record.archivedAt.toDate().toLocaleDateString()}</td><td><button type="button" className="secondary" onClick={()=>{setSelected(record);setCaptureError("");}}>View {record.job.jobNumber}</button></td></tr>)}</tbody></table></div>}
    {loading&&<p role="status">Loading archive…</p>}{!loading&&!error&&!records.length&&<p>No archived jobs yet. Archive an approved job from Billing to keep its full details here.</p>}
    {hasMore&&<button type="button" className="secondary" disabled={loading} onClick={()=>void more()}>Load 25 more jobs</button>}
    <p className="archive-hint">Records load in pages of 25. Sorting applies to the full archive; job numbers use alphabetical order.</p>
    {selected&&<div className="job-editor-overlay" role="dialog" aria-modal="true" aria-label={`Archived job ${selected.job.jobNumber}`}><article className="panel archive-details"><header className="panel-head"><div><h2>Archived job {selected.job.jobNumber}</h2><p>{selected.job.customer} · Read only</p></div><button type="button" className="secondary" autoFocus onClick={()=>setSelected(null)}>Close details</button></header>{selected.historyStatus==="capturing"&&<div className="history-capture-warning"><b>History capture pending</b><p>The job is preserved. Finish copying its recorded history before treating this archive as complete.</p>{resumeHistory&&<button type="button" className="secondary" disabled={capturing} onClick={async()=>{setCapturing(true);setCaptureError("");try{await resumeHistory(selected.id);setSelected({...selected,historyStatus:"complete"});setRecords(items=>items.map(item=>item.id===selected.id?{...item,historyStatus:"complete"}:item));}catch(reason){setCaptureError(reason instanceof Error?reason.message:"Capture failed. Retry when connected.");}finally{setCapturing(false);}}}>{capturing?"Capturing history…":"Retry history capture"}</button>}{captureError&&<p role="alert">{captureError}</p>}</div>}<DepartmentHistory key={`${selected.id}-${selected.historyStatus}`} job={selected.job} departments={selected.departments} statuses={selected.statuses} loadEvents={selectedHistory} archived captureStatus={selected.historyStatus}/><dl><dt>Archived</dt><dd>{selected.archivedAt.toDate().toLocaleString()}</dd>{Object.entries(selected.job).filter(([key])=>!["parts","savedCustomerRepresentatives","savedProjectManagers"].includes(key)).map(([key,value])=><div key={key}><dt>{fieldLabel(key)}</dt><dd>{displayValue(key,value,selected)}</dd></div>)}</dl>{selected.job.parts?.map(part=><section key={part.id}><h3>{part.code} · {part.name}</h3><dl>{Object.entries(part).map(([key,value])=><div key={key}><dt>{fieldLabel(key)}</dt><dd>{displayValue(key,value,selected)}</dd></div>)}</dl></section>)}<p>Movement events remain in Job History.</p></article></div>}
  </div>;
}
function fieldLabel(key:string){return key.replace(/([A-Z])/g," $1").replace(/^./,letter=>letter.toUpperCase());}
function displayValue(key:string,value:unknown,record:ArchivedJob):string{
  const department=(id:unknown)=>record.departments.find(item=>item.id===id)?.name||String(id||"Not started");
  if(key==="currentDepartmentId")return department(value);
  if(key==="route"&&Array.isArray(value))return value.map(department).join(" → ")||"—";
  if(value===undefined||value===null||value==="")return "—";
  if(typeof value==="boolean")return value?"Yes":"No";
  return typeof value==="object"?JSON.stringify(value):String(value);
}
