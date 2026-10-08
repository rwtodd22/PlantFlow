import {useState} from 'react';
import type {PeopleNames} from '../lib/jobPeople';
import {cloudDataService} from '../lib/cloudDataService';

export function SavedPeopleManager({names}:{names:PeopleNames}) {
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const remove=async(field:'customerRepresentative'|'projectManager',name:string)=>{
  if(busy||!window.confirm(`Remove ${name} from the saved ${field==='customerRepresentative'?'customer representative':'project manager'} list? Existing jobs and archives will keep this name.`))return;
  setBusy(true);setError('');
  try{await cloudDataService.removeSavedPerson(field,name);}catch{setError('Could not remove the saved name. Check your connection and administrator access, then try again.');}finally{setBusy(false);}
 };
 return <details className="saved-people-manager"><summary>Manage saved names</summary><p>Remove names from future suggestions without changing existing jobs or archives.</p>{(['customerRepresentative','projectManager'] as const).map(field=><section key={field}><b>{field==='customerRepresentative'?'Customer representatives':'Project managers'}</b><div className="saved-people-chips">{(field==='customerRepresentative'?names.customerRepresentatives:names.projectManagers).map(name=><span key={name}>{name}<button type="button" disabled={busy} aria-label={`Remove ${field==='customerRepresentative'?'customer representative':'project manager'} ${name}`} onClick={()=>void remove(field,name)}>×</button></span>)}</div></section>)}{error&&<p role="alert">{error}</p>}{busy&&<small role="status">Removing saved name…</small>}</details>;
}
