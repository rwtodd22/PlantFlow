import { useEffect, useId, useRef, useState } from "react";
import type { PeopleNames } from "../lib/jobPeople";
import { cleanPersonName,uniquePersonNames } from "../lib/jobPeople";
import type { Job } from "../lib/dataService";
export function JobPeopleFields({names,job,onChange,onRemove,onSave}:{names:PeopleNames;job?:Pick<Job,"customerRepresentative"|"projectManager">;onSave?:(field:"customerRepresentative"|"projectManager",name:string)=>Promise<void>;onRemove?:(field:"customerRepresentative"|"projectManager",name:string)=>Promise<void>;onChange?:(field:"customerRepresentative"|"projectManager",value:string)=>void}){
 return <><PersonField label="Account Representative" field="customerRepresentative" names={names.customerRepresentatives} initial={job?.customerRepresentative||""} onChange={onChange} onRemove={onRemove} onSave={onSave}/><PersonField label="Project Manager" field="projectManager" names={names.projectManagers} initial={job?.projectManager||""} onChange={onChange} onRemove={onRemove} onSave={onSave}/></>;
}
function PersonField({label,field,names,initial,onChange,onRemove,onSave}:{label:string;field:"customerRepresentative"|"projectManager";names:string[];initial:string;onSave?:(field:"customerRepresentative"|"projectManager",name:string)=>Promise<void>;onRemove?:(field:"customerRepresentative"|"projectManager",name:string)=>Promise<void>;onChange?:(field:"customerRepresentative"|"projectManager",value:string)=>void}){
 const [value,setValue]=useState(initial);const [adding,setAdding]=useState(false);const [draft,setDraft]=useState("");const root=useRef<HTMLDivElement>(null);
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [added,setAdded]=useState<string[]>([]);
 const [removed,setRemoved]=useState<string[]>([]);
 const trigger=useRef<HTMLButtonElement>(null);const id=useId();
 const options=uniquePersonNames([...names,...added,value]).filter(name=>!removed.includes(name));
 useEffect(()=>{if(!open)return;const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};document.addEventListener("pointerdown",outside);return()=>document.removeEventListener("pointerdown",outside);},[open]);
 const remove=async(name:string)=>{
  if(!onRemove||busy||!window.confirm(`Remove ${name} from the saved ${label.toLowerCase()} list? Existing jobs and archives will keep this name.`))return;
  setBusy(true);setError("");
  try{await onRemove(field,name);setRemoved(current=>[...current,name]);setAdded(current=>current.filter(item=>item!==name));trigger.current?.focus();}
  catch{setError("Could not remove the saved name. Check your connection and administrator access, then try again.");}
  finally{setBusy(false);}
 };
 const choose=(next:string)=>{setValue(next);onChange?.(field,next);setOpen(false);setAdding(false);trigger.current?.focus();};
 const saveDraft=async()=>{
  const name=cleanPersonName(draft);
  if(!name||busy)return;
  if(!onSave){choose(name);return;}
  setBusy(true);setError("");
  try{
   await onSave(field,name);
   setRemoved(current=>current.filter(item=>item.toLocaleLowerCase()!==name.toLocaleLowerCase()));
   setAdded(current=>uniquePersonNames([...current,name]));
   choose(name);
  }catch{setError("Could not save this name. Check your connection and administrator access, then try again.");}
  finally{setBusy(false);}
 };
 useEffect(()=>{const form=root.current?.closest("form");const reset=()=>{setValue(initial);setOpen(false);setError("");setAdding(false);setDraft("");};form?.addEventListener("reset",reset);return()=>form?.removeEventListener("reset",reset);},[initial]);
 return <div ref={root} className="person-field" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setOpen(false);}} onKeyDown={event=>{if(event.key==="Escape"&&open){event.preventDefault();event.stopPropagation();setOpen(false);trigger.current?.focus();}}}>
 <span id={id+"-label"} className="person-field-label">{label}</span>
 <input type="hidden" name={field} value={value}/>
 <button ref={trigger} type="button" className="person-select-trigger" aria-labelledby={id+"-label "+id+"-value"} aria-expanded={open} aria-controls={id+"-choices"} onClick={()=>setOpen(current=>!current)}><span id={id+"-value"}>{value||"Not assigned"}</span><span aria-hidden="true">⌄</span></button>
 {open&&<div id={id+"-choices"} className="person-choices" role="group" aria-labelledby={id+"-label"}>
 <button type="button" className="person-choice" onClick={()=>choose("")}>Not assigned</button>
 {options.map(name=><div className="person-choice-row" key={name}><button type="button" className="person-choice" aria-pressed={value===name} onClick={()=>choose(name)}>{name}</button>{onRemove&&(names.includes(name)||added.includes(name))&&<button type="button" className="person-remove" disabled={busy} aria-label={`Remove ${label.toLowerCase()} ${name}`} title={`Remove saved name: ${name}`} onClick={()=>void remove(name)}>×</button>}</div>)}
 <button type="button" className="person-choice person-new" onClick={()=>{setAdding(true);setDraft("");setOpen(false);}}>+ Add New</button>
 </div>}
 {busy&&<small role="status">Updating saved names…</small>}{error&&<small role="alert">{error}</small>}
 {adding&&<div className="person-add"><label><span>New {label}</span><input autoFocus disabled={busy} aria-label={`New ${label}`} value={draft} maxLength={120} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();void saveDraft();}}}/></label><div><button type="button" className="secondary" disabled={busy||!cleanPersonName(draft)} onClick={()=>void saveDraft()}>{busy?"Saving…":onSave?"Save name":"Use name"}</button><button type="button" className="secondary" disabled={busy} onClick={()=>setAdding(false)}>Cancel</button></div><small>{onSave?"Saved immediately for reuse in future jobs.":"Saved for reuse when the job is saved."}</small></div>}</div>;
}
export function JobPeopleInfo({job}:{job:Pick<Job,"customerRepresentative"|"projectManager">}){return <dl className="job-people-info"><div><dt>Account Representative</dt><dd>{job.customerRepresentative||"Not assigned"}</dd></div><div><dt>Project Manager</dt><dd>{job.projectManager||"Not assigned"}</dd></div></dl>;}
