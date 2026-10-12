import {useState} from 'react';

export function DownloadReportButton({selector}:{selector:string}) {
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  return <><button type="button" className="primary" disabled={busy} onClick={async()=>{
    setBusy(true);setError('');
    try {
      const report=document.querySelector<HTMLElement>(selector);
      if(!report)throw new Error('Report unavailable');
      const {downloadReport}=await import('../lib/downloadReport');
      await downloadReport(report);
    }catch{setError('PDF could not be downloaded. Please try again.');}
    finally{setBusy(false);}
  }}>{busy?'Preparing PDF…':'Download PDF'}</button>{error&&<p role="alert">{error}</p>}</>;
}
