import {useEffect,useState} from 'react';

/** A slow connection should never leave a portal with only an endless spinner. */
export function PortalLoading({title='Opening PlantFlow…',detail='Connecting to PlantFlow',onRetry=()=>window.location.reload()}:{title?:string;detail?:string;onRetry?:()=>void}) {
  const [slow,setSlow]=useState(false);
  useEffect(()=>{const timer=window.setTimeout(()=>setSlow(true),8000);return()=>window.clearTimeout(timer);},[]);
  return <div className="auth-screen"><div className="auth-loading" role="status"><span className="auth-spinner"/><b>{title}</b><small>{slow?'The connection is taking longer than expected. Check your connection or try again.':detail}</small>{slow&&<button className="secondary" onClick={onRetry}>Try again</button>}</div></div>;
}
