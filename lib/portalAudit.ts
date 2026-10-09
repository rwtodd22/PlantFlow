import type {AppState,ScanEvent} from "./dataService";
export function portalAudit(before:AppState,after:AppState,uid:string,name:string,now:string,id:()=>string):ScanEvent[]{
 const events:ScanEvent[]=[];
 for(const job of after.jobs){
  const old=before.jobs.find(j=>j.id===job.id);if(!old)continue;
  const fields=["currentDepartmentId","status","notes","dueDate","priority","customer","description","customerRepresentative","projectManager","parts","route","overtime"] as const;
  const changes=fields.filter(field=>JSON.stringify(old[field])!==JSON.stringify(job[field]));
  if(!changes.length)continue;
  events.push({id:id(),jobId:job.id,jobNumber:job.jobNumber,departmentId:job.currentDepartmentId,departmentName:after.departments.find(d=>d.id===job.currentDepartmentId)?.name||"Not started",previousDepartmentId:old.currentDepartmentId,timestamp:now,type:"Manual",auditOnly:true,actorUid:uid,actorName:name,changedFields:changes.map(field=>({currentDepartmentId:"Location",customerRepresentative:"Account representative",projectManager:"Project manager",dueDate:"Due date",parts:"Job parts",notes:"Notes",status:"Status",priority:"Priority",customer:"Customer",description:"Description",route:"Route",overtime:"Overtime"}[field]||field))});
 }
 return events;
}
