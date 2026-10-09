import type {Job, Department, StatusDefinition, ScanEvent} from "./dataService";

export function scanTransition(job:Job, departments:Department[], statuses:StatusDefinition[], code:string, prefix:string, statusId:string|undefined, now:string, eventId:string) {
  const matches=departments.filter(d=>d.enabled&&d.prefix.toUpperCase()===prefix);
  if(matches.length!==1)throw new Error("Scanner department is missing, disabled, or ambiguous.");
  const department=matches[0];
  const part=job.parts?.find(p=>p.code.toUpperCase()===code);
  if(job.parts?.length&&!part)throw new Error("Scan the barcode for the specific job part.");
  if(!part&&job.jobNumber.toUpperCase()!==code)throw new Error("This barcode has changed. Refresh and scan again.");
  const tracked=part||job;
  if(statuses.find(s=>s.name===tracked.status)?.closesJob)throw new Error("Reopen this job or part before scanning it.");
  const status=statusId?statuses.find(s=>s.id===statusId&&s.enabled):statuses.find(s=>s.code==="IN_PRODUCTION"&&s.enabled&&!s.closesJob);
  if(!status)throw new Error("The requested status is disabled or unavailable. Ask an administrator to enable it.");
  const elapsed=Date.parse(now)-Date.parse(tracked.updatedAt);
  if(!statusId&&tracked.currentDepartmentId===department.id&&elapsed>=0&&elapsed<30000)return null;
  const previousDepartmentId=tracked.currentDepartmentId;
  const currentIndex=job.route.indexOf(previousDepartmentId), nextIndex=job.route.indexOf(department.id);
  const update={currentDepartmentId:department.id,status:status.name,updatedAt:now};
  let next:Job=part?{...job,updatedAt:now,parts:job.parts!.map(p=>p.id===part.id?{...p,...update}:p)}:{...job,...update};
  const complete=(name:string)=>statuses.some(s=>s.name===name&&s.code==="COMPLETE");
  if(next.parts?.length?next.parts.every(p=>complete(p.status)):complete(next.status))next={...next,completedAt:next.completedAt||now};
  const event:ScanEvent={id:eventId,jobId:job.id,timestampBasis:"recorded",jobNumber:part?.code||job.jobNumber,departmentId:department.id,departmentName:department.name,previousDepartmentId,timestamp:now,type:statusId?"Status command":nextIndex===currentIndex+1||currentIndex===-1?"Normal":"Route exception",...(statusId?{statusName:status.name,statusClosesJob:status.closesJob}:{}),...(part?{partId:part.id,partCode:part.code,partName:part.name}:{})};
  return {job:next,event};
}
