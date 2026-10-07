import {useState} from 'react';
import type {Department,Job,StatusDefinition} from '../lib/dataService';
import type {ProductionReturn} from '../lib/returnToProduction';

export function ReturnToProductionDialog({job,departments,statuses,onReturn,onClose}:{job:Job;departments:Department[];statuses:StatusDefinition[];onReturn:(jobId:string,changes:ProductionReturn[])=>Promise<void>;onClose:()=>void}) {
  const available = statuses.filter(status=>status.enabled&&!status.closesJob);
  const rows = job.parts?.length ? job.parts.map(part=>({key:part.id,label:`${part.code} · ${part.name}`,departmentId:part.currentDepartmentId,partId:part.id})) : [{key:job.id,label:`Job ${job.jobNumber}`,departmentId:job.currentDepartmentId,partId:undefined}];
  const [choices,setChoices]=useState(()=>rows.map(row=>({...row,selected:!job.parts?.length,status:available[0]?.name||''})));
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const update=(key:string,changes:Partial<typeof choices[number]>)=>setChoices(current=>current.map(choice=>choice.key===key?{...choice,...changes}:choice));
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try {await onReturn(job.id,choices.filter(choice=>choice.selected).map(({partId,departmentId,status})=>({partId,departmentId,status})));onClose();}
    catch(error){setError(error instanceof Error?error.message:'Could not return this job. Please try again.');}
    finally{setBusy(false);}
  };
  return <div className="job-editor-overlay" role="dialog" aria-modal="true" aria-label={`Return job ${job.jobNumber} to production`}>
    <form className="job-editor return-production-dialog" onSubmit={submit}>
      <h2>Return Job {job.jobNumber} to Production</h2>
      <p>This removes billing approval and returns the job to Active Jobs and the Live Dashboard. Notes and history are kept. Unselected parts remain complete.</p>
      {rows.length>5&&<p>Select up to five parts to return together. You can change additional parts from Active Jobs afterward.</p>}
      <fieldset disabled={busy}>
        {choices.map(choice=><section key={choice.key} className="return-production-row">
          {job.parts?.length?<label className="return-part-choice"><input type="checkbox" disabled={!choice.selected&&choices.filter(item=>item.selected).length>=5} checked={choice.selected} onChange={event=>update(choice.key,{selected:event.target.checked})}/>{choice.label}</label>:<b>{choice.label}</b>}
          <div className="return-production-fields">
            <label>Department<select aria-label={`Department for ${choice.label}`} disabled={!choice.selected} value={choice.departmentId} onChange={event=>update(choice.key,{departmentId:event.target.value})}><option value="">Not started</option>{departments.filter(department=>department.enabled).map(department=><option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
            <label>Production status<select aria-label={`Status for ${choice.label}`} disabled={!choice.selected} value={choice.status} onChange={event=>update(choice.key,{status:event.target.value})}>{available.map(status=><option key={status.id} value={status.name}>{status.name}</option>)}</select></label>
          </div>
        </section>)}
        {error&&<p className="auth-error" role="alert">{error}</p>}
        {!available.length&&<p role="alert">Enable an active production status in Administration before returning jobs.</p>}
        <div className="reprint-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={!available.length||!choices.some(choice=>choice.selected)}>{busy?'Returning…':'Return to Production'}</button></div>
      </fieldset>
    </form>
  </div>;
}
