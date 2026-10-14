import {useRef,useState} from 'react';
import {getFunctions,httpsCallable} from 'firebase/functions';
import {ReadyForBilling} from './ReadyForBilling';
import type {AppState,Job} from '../lib/dataService';

const manage=()=>httpsCallable(getFunctions(undefined,'us-central1'),'manageWfBilling',{timeout:540000});
export function WfPortalBilling({state}:{state:AppState}) {
  const [busy,setBusy]=useState(false);
  const lock=useRef(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  async function run(ids:string[],action:'update'|'archive',updates?:Pick<Job,'billingState'|'billingNote'>){
    if(lock.current)return;
    if(action==='archive'&&!window.confirm(`Archive ${ids.length} approved Wide Format job(s)? Full details and history will be preserved.`))return;
    lock.current=true;setBusy(true);setMessage('');setError('');
    let done=0;
    try{
      for(const jobId of ids){
        const job=state.jobs.find(item=>item.id===jobId);
        await manage()({action,jobId,...(action==='update'?{billingState:updates?.billingState||'approved',billingNote:updates?.billingNote??job?.billingNote??''}:{})});
        done++;setMessage(`${done} of ${ids.length} ${action==='archive'?'archived':'saved'}.`);
      }
    }catch(reason){setError(`${done} of ${ids.length} finished. ${reason instanceof Error?reason.message:'Could not save. Please try again.'}${action==='archive'?' Any job already moved to Archive is preserved; history capture retries automatically.':''}`);}
    finally{lock.current=false;setBusy(false);}
  }
  return <>{message&&<p role="status">{message}</p>}{error&&<p role="alert" className="archive-error">{error}</p>}<ReadyForBilling wideFormat standalone jobs={state.jobs} statuses={state.statuses} departments={state.departments} archiveBusy={busy} onApprove={ids=>void run(ids,'update')} onUpdate={(id,updates)=>void run([id],'update',updates)} onClear={ids=>run(ids,'archive')}/></>;
}
