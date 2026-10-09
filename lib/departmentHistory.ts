import type { Department, Job, ScanEvent, StatusDefinition } from "./dataService";
export type DepartmentVisit = { track: string; departmentId: string; departmentName: string; arrival?: string; departure?: string; ongoing: boolean; observations: number; notes: string[]; elapsedMs?: number };
export type DepartmentHistory = { visits: DepartmentVisit[]; warnings: string[]; eventCount: number };

/** Event timestamps are recorded observations, not a labor clock. Never use the editable job.updatedAt clock. */
export function departmentHistory(job:Job,events:ScanEvent[],departments:Department[],statuses:StatusDefinition[],now=Date.now(),archived=false):DepartmentHistory {
  const warnings=new Set<string>();
  const unique=[...new Map(events.filter(event=>!event.auditOnly).map(event=>[event.id,event])).values()];
  const valid=unique.filter(event=>{if(Number.isFinite(Date.parse(event.timestamp)))return true;warnings.add("Some events have missing or invalid timestamps; those boundaries are unknown.");return false;});
  if(unique.some(event=>!event.jobId))warnings.add("Legacy events are linked by barcode, not a permanent job ID. Renamed or reused barcodes may leave missing or uncertain associations.");
  if(unique.some(event=>event.type==="Manual"&&!event.timestampBasis))warnings.add("Older manual-event timestamps may have been adjusted. They are shown as recorded, not verified physical arrival times.");
  const closing=new Set(statuses.filter(status=>status.closesJob).map(status=>status.name));
  const name=(id:string)=>departments.find(item=>item.id===id)?.name||id||"Not started";
  const tracks=[{id:undefined as string|undefined,code:job.jobNumber,label:job.parts?.length?`${job.jobNumber} · parent before split`:job.jobNumber,current:job.currentDepartmentId,status:job.status,parent:Boolean(job.parts?.length)},...(job.parts||[]).map(part=>({id:part.id,code:part.code,label:`${part.code} · ${part.name}`,current:part.currentDepartmentId,status:part.status,parent:false}))];
  const knownPartIds=new Set((job.parts||[]).map(part=>part.id));
  for(const event of valid)if(event.partId&&!knownPartIds.has(event.partId)){knownPartIds.add(event.partId);tracks.push({id:event.partId,code:event.partCode||event.jobNumber,label:`${event.partCode||event.jobNumber} · historical part`,current:"",status:"",parent:true});}
  const visits:DepartmentVisit[]=[];
  for(const track of tracks){
    const relevant=valid.filter(event=>track.id?event.partId===track.id||(!event.partId&&event.jobNumber===track.code):!event.partId&&(event.jobId===job.id||event.jobNumber===track.code)).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp)||a.id.localeCompare(b.id));
    let current:DepartmentVisit|undefined;
    let first=true;
    let previouslyClosed=false;
    const add=(id:string,arrival?:string,notes:string[]=[])=>{const row:DepartmentVisit={track:track.label,departmentId:id,departmentName:name(id),arrival,ongoing:false,observations:0,notes};visits.push(row);return row;};
    for(let i=0;i<relevant.length;){
      const time=relevant[i].timestamp;const group:ScanEvent[]=[];
      while(i<relevant.length&&Date.parse(relevant[i].timestamp)===Date.parse(time))group.push(relevant[i++]);
      const locations=new Set(group.map(event=>event.departmentId));
      const terminal=group.some(event=>event.statusClosesJob ?? Boolean(event.statusName&&closing.has(event.statusName)));
      const reopened=group.some(event=>Boolean(event.statusName)&&(event.statusClosesJob === false || (event.statusClosesJob === undefined && statuses.some(status=>status.name===event.statusName&&!status.closesJob))));
      if(locations.size>1||(terminal&&reopened)){
        warnings.add("Simultaneous conflicting events have unknown ordering; affected durations are not calculated.");
        if(current){current.notes.push("Next event order is ambiguous; departure unknown.");current=undefined;}
        for(const event of group){const row=add(event.departmentId,undefined,[`Observed at ${event.timestamp}; ordering ambiguous.`]);row.observations++;}
        first=false;previouslyClosed=false;continue;
      }
      const event=group[0];const location=event.departmentId;
      if(first&&event.previousDepartmentId&&event.previousDepartmentId!==location){const previous=add(event.previousDepartmentId,undefined,["Arrival not recorded."]);previous.departure=time;}
      first=false;
      if(current&&current.departmentId!==location){
        if(group.some(item=>item.previousDepartmentId&&item.previousDepartmentId!==current!.departmentId))current.notes.push("Recorded previous location conflicts; departure unknown.");
        else current.departure=time;
        current=undefined;
      }
      if(!current){
        const isArrival=group.some(item=>item.previousDepartmentId!==location)||(reopened&&previouslyClosed);
        current=add(location,isArrival?time:undefined,isArrival?[]:["Already here at first observation; arrival unknown."]);
        previouslyClosed=false;
      }
      current.observations+=group.length;
      if(group.some(item=>item.type==="Manual"))current.notes.push("Contains a manual observation.");
      if(terminal){current.departure=time;current.notes.push("Ended by a closing-status event; not proof of physical departure.");current=undefined;previouslyClosed=true;}
    }
    if(current){
      if(!archived&&!track.parent&&!closing.has(track.status)&&track.current===current.departmentId)current.ongoing=true;
      else current.notes.push("No recorded departure or closing event; end unknown.");
    }else if(!relevant.length&&track.current&&!track.parent){
      const row=add(track.current,undefined,["No arrival event recorded."]);row.ongoing=!archived&&!closing.has(track.status);
    }
  }
  for(const row of visits){const end=row.departure?Date.parse(row.departure):row.ongoing?now:undefined;if(row.arrival&&end!==undefined){const duration=end-Date.parse(row.arrival);if(duration>=0)row.elapsedMs=duration;else row.notes.push("Timestamp is in the future; duration unknown.");}row.notes=[...new Set(row.notes)];}
  return {visits,warnings:[...warnings],eventCount:unique.length};
}
export function elapsedDuration(ms:number|undefined){if(ms===undefined)return "Unknown";const minutes=Math.floor(ms/60000);const days=Math.floor(minutes/1440);const hours=Math.floor((minutes%1440)/60);const remaining=minutes%60;return [days?`${days}d`:"",hours?`${hours}h`:"",`${remaining}m`].filter(Boolean).join(" ");}
