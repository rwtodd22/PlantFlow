import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import { Job, seedState } from "../lib/dataService";
import { cloudDataService } from "../lib/cloudDataService";
import { usePlantFlowAuth } from "./auth";
import { ReadOnlyPortal } from "./App";
import worthHigginsLogo from "./assets/WHALogo_Horizontal.png";

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `pf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,11)}`;
}

function localDateValue(offsetDays=0) {
  const date=new Date();
  date.setDate(date.getDate()+offsetDays);
  const localOffset=date.getTimezoneOffset()*60_000;
  return new Date(date.getTime()-localOffset).toISOString().slice(0,10);
}

type Feedback={kind:"success"|"error";title:string;detail:string}|null;
type LabelPreview={jobNumber:string;customer:string;description:string;dueDate:string};

function IntakeBarcode({value}:{value:string}) {
  const ref=useRef<SVGSVGElement>(null);
  useLayoutEffect(()=>{
    if(!ref.current||!value)return;
    JsBarcode(ref.current,value,{format:"CODE128",displayValue:false,height:58,margin:0,width:2});
  },[value]);
  return <div className="intake-barcode"><svg ref={ref}/><b>{value}</b></div>;
}

export default function JobIntakePortal() {
  const {user,profile,logout}=usePlantFlowAuth();
  const [state,setState]=useState(seedState);
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [feedback,setFeedback]=useState<Feedback>(null);
  const [dueDate,setDueDate]=useState(()=>localDateValue(3));
  const [formVersion,setFormVersion]=useState(0);
  const [jobNumber,setJobNumber]=useState("");
  const [createdJob,setCreatedJob]=useState<Job|null>(null);
  const [printPreview,setPrintPreview]=useState<LabelPreview|null>(null);
  const [labelPreviewOpenedFor,setLabelPreviewOpenedFor]=useState("");
  const [activeTab,setActiveTab]=useState<"create"|"viewer">("create");
  const [portalTheme,setPortalTheme]=useState<"light"|"dark">(()=>window.localStorage.getItem("plantflow-intake-theme")==="dark"?"dark":"light");
  const formRef=useRef<HTMLFormElement>(null);

  const changePortalTheme=(theme:"light"|"dark")=>{
    setPortalTheme(theme);
    window.localStorage.setItem("plantflow-intake-theme",theme);
  };

  useEffect(()=>cloudDataService.subscribeJobIntake(next=>{
    if(next)setState(next);
    setLoading(false);
  },error=>{
    setFeedback({kind:"error",title:"PlantFlow could not load",detail:error.message||"Check the internet connection and try again."});
    setLoading(false);
  }),[]);

  const enabledDepartments=useMemo(()=>state.departments.filter(item=>item.enabled).sort((a,b)=>a.order-b.order),[state.departments]);

  const submit=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();
    const formElement=event.currentTarget;
    const form=new FormData(formElement);
    const jobNumber=String(form.get("jobNumber")||"").trim().toUpperCase();
    if(state.jobs.some(job=>job.jobNumber.toUpperCase()===jobNumber)){
      setFeedback({kind:"error",title:"That job number already exists",detail:`Job ${jobNumber} is already stored in PlantFlow.`});
      return;
    }
    const initialDepartmentId=String(form.get("initialDepartmentId")||"");
    const initialStatus=initialDepartmentId
      ? state.statuses.find(item=>item.code==="IN_PRODUCTION")?.name||"In Production"
      : state.statuses.find(item=>item.code==="READY")?.name||"Ready for Production";
    const route=enabledDepartments.filter(department=>form.get(`route-${department.id}`)).map(department=>department.id);
    const now=new Date().toISOString();
    const job:Job={
      id:makeId(),jobNumber,
      customer:String(form.get("customer")||"").trim(),
      description:String(form.get("description")||"").trim(),
      dueDate:String(form.get("dueDate")||dueDate),
      priority:String(form.get("priority")||"Standard") as Job["priority"],
      status:initialStatus,currentDepartmentId:initialDepartmentId,route,
      notes:String(form.get("notes")||"").trim(),
      overtime:form.get("overtime")==="on",
      createdAt:now,updatedAt:now,createdBy:user.uid,
      createdByName:profile.displayName||profile.email,
    };
    setSaving(true);setFeedback(null);
    try{
      await cloudDataService.createJobFromIntake(job);
      setState(current=>({...current,jobs:[job,...current.jobs]}));
      setFeedback({kind:"success",title:`Job ${jobNumber} created`,detail:`${job.customer} has been added to PlantFlow and is ready for production planning.`});
      setCreatedJob(job);
      if(labelPreviewOpenedFor!==jobNumber)setPrintPreview({jobNumber,customer:job.customer,description:job.description,dueDate:job.dueDate});
      setJobNumber("");
      setDueDate(localDateValue(3));
      setFormVersion(current=>current+1);
      formElement.reset();
      window.scrollTo({top:0,behavior:"smooth"});
    }catch(error){
      setFeedback({kind:"error",title:"The job was not created",detail:error instanceof Error?error.message:"PlantFlow could not save this job."});
    }finally{setSaving(false);}
  };

  const previewNumber=jobNumber.trim().toUpperCase()||createdJob?.jobNumber||"";
  const openPrintPreview=()=>{
    if(!previewNumber)return;
    const form=formRef.current?new FormData(formRef.current):null;
    setPrintPreview({
      jobNumber:previewNumber,
      customer:String(form?.get("customer")||createdJob?.customer||"").trim(),
      description:String(form?.get("description")||createdJob?.description||"").trim(),
      dueDate:String(form?.get("dueDate")||createdJob?.dueDate||dueDate),
    });
    setLabelPreviewOpenedFor(previewNumber);
  };

  const printLabel=()=>{
    if(!printPreview)return;
    const sourceSheet=document.querySelector<HTMLElement>(".intake-portal .reprint-overlay .reprint-sheet");
    if(!sourceSheet){
      setFeedback({kind:"error",title:"Barcode label is not ready",detail:"Close the preview, open it again, and retry printing."});
      return;
    }
    const printWindow=window.open("","plantflow-intake-barcode-print","width=640,height=760");
    if(!printWindow){
      setFeedback({kind:"error",title:"Print window was blocked",detail:"Allow pop-up windows for PlantFlow in Safari, then click Print Barcode Label again."});
      return;
    }
    const label=sourceSheet.cloneNode(true) as HTMLElement;
    const sourceImages=Array.from(sourceSheet.querySelectorAll<HTMLImageElement>("img"));
    Array.from(label.querySelectorAll<HTMLImageElement>("img")).forEach((image,index)=>{image.src=sourceImages[index]?.src||image.src;});
    printWindow.document.open();
    printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>PlantFlow Barcode Label</title><style>
      @page{size:auto;margin:.25in}*{box-sizing:border-box}html,body{width:100%;margin:0;padding:0;background:#fff;color:#14231e;font-family:Arial,Helvetica,sans-serif}body{display:flex;justify-content:center;align-items:flex-start;padding:.15in 0 0}.reprint-sheet{width:4in;margin:0 auto;padding:24px;border:1px solid #000;background:#fff;text-align:center;break-inside:avoid;page-break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact}.reprint-sheet>img{display:block;width:190px;height:auto;margin:0 auto 22px}.reprint-sheet>small,.reprint-sheet>strong,.reprint-details>b,.reprint-details>span{display:block}.reprint-sheet>small{color:#56635e;font-size:10px;font-weight:700;letter-spacing:.12em}.reprint-sheet>strong{margin:6px 0 12px;color:#14231e;font-size:30px}.intake-barcode,.intake-barcode svg{display:block;max-width:100%;margin-inline:auto;overflow:visible}.intake-barcode b{display:block;margin-top:4px;color:#14231e;font-size:14px;letter-spacing:.08em}.reprint-details{margin-top:14px;padding-top:12px;border-top:1px solid #d8dfdc;color:#14231e;font-size:11px}.reprint-details span{margin-top:4px;color:#5f6d67}@media print{html,body{width:100%;height:auto;overflow:visible}body{display:flex!important;justify-content:center!important;align-items:flex-start!important}.reprint-sheet{margin:0 auto!important}}
    </style></head><body>${label.outerHTML}</body></html>`);
    printWindow.document.close();
    printWindow.addEventListener("afterprint",()=>printWindow.close(),{once:true});
    const openPrintDialog=()=>{
      printWindow.focus();
      printWindow.print();
    };
    const logo=printWindow.document.querySelector<HTMLImageElement>("img");
    if(logo&&!logo.complete){
      logo.addEventListener("load",openPrintDialog,{once:true});
      logo.addEventListener("error",openPrintDialog,{once:true});
    }else{
      openPrintDialog();
    }
  };

  if(loading)return <div className="intake-loading"><span/><b>Opening the Job Creation Portal…</b></div>;

  return <div className={`intake-portal intake-theme-${portalTheme}`}>
    <header className="intake-header"><div className="intake-brand"><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><div><p className="eyebrow">PLANTFLOW JOB INTAKE</p><h1>Job Creation Portal</h1><span>Create a production record and send it directly into PlantFlow.</span></div></div><div className="intake-header-tools"><div className="intake-theme-toggle" role="group" aria-label="Job Creation Portal color mode"><button type="button" className={portalTheme==="light"?"active":""} aria-pressed={portalTheme==="light"} onClick={()=>changePortalTheme("light")}>Light</button><button type="button" className={portalTheme==="dark"?"active":""} aria-pressed={portalTheme==="dark"} onClick={()=>changePortalTheme("dark")}>Dark</button></div><div className="intake-user"><div><b>{profile.displayName||profile.email}</b><small>Job creation access</small></div><button type="button" onClick={()=>void logout()}>Sign out</button></div></div></header>
    <nav className="intake-tabs" aria-label="Job Creation Portal sections">
      <button type="button" className={activeTab==="create"?"active":""} aria-current={activeTab==="create"?"page":undefined} onClick={()=>setActiveTab("create")}><span>＋</span><div><b>Create Job</b><small>Enter and label a new production job</small></div></button>
      <button type="button" className={activeTab==="viewer"?"active":""} aria-current={activeTab==="viewer"?"page":undefined} onClick={()=>setActiveTab("viewer")}><span>≡</span><div><b>Production Viewer</b><small>Review the live production workload</small></div></button>
    </nav>
    {activeTab==="create"?<main className="intake-main">
      {feedback&&<div className={`intake-feedback ${feedback.kind}`} role="status"><span>{feedback.kind==="success"?"✓":"!"}</span><div><b>{feedback.title}</b><small>{feedback.detail}</small></div><button type="button" aria-label="Dismiss message" onClick={()=>setFeedback(null)}>×</button></div>}
      <div className="intake-workspace"><form ref={formRef} key={formVersion} className="intake-form" onSubmit={submit}>
        <section className="intake-form-heading"><div><p className="eyebrow">NEW PRODUCTION JOB</p><h2>Start a job</h2><p>Enter the core job information below. Production staff can review and adjust the record after creation.</p></div><span>Fields marked * are required</span></section>
        <div className="intake-fields">
          <label><span>PACE job number *</span><input name="jobNumber" required autoFocus placeholder="e.g. 590042" autoComplete="off" value={jobNumber} onChange={event=>{setJobNumber(event.target.value.toUpperCase());if(createdJob)setCreatedJob(null);}}/></label>
          <label><span>Customer *</span><input name="customer" required placeholder="Customer name"/></label>
          <label className="wide"><span>Job description *</span><input name="description" required placeholder="Project name or production description"/></label>
          <label><span>Production due date *</span><input name="dueDate" type="date" required min={localDateValue()} value={dueDate} onChange={event=>setDueDate(event.target.value)}/></label>
          <label><span>Priority</span><select name="priority" defaultValue="Standard"><option>Standard</option><option>Rush</option><option>Critical</option></select></label>
          <label className="wide intake-location"><span>Starting location <small>Optional</small></span><select name="initialDepartmentId" defaultValue=""><option value="">Not started</option>{enabledDepartments.map(department=><option key={department.id} value={department.id}>{department.name}</option>)}</select><small>Leave as Not started unless the job is already physically in production.</small></label>
          <label className="wide intake-notes"><span>Production notes</span><textarea name="notes" rows={4} placeholder="Materials, finishing details, special handling, or other useful production information"/></label>
          <label className="wide intake-overtime"><input type="checkbox" name="overtime"/><span><b>Overtime tracking</b><small>Count evenings, nights, and weekends for this job.</small></span></label>
        </div>
        <fieldset className="intake-route"><legend>Expected production route</legend><p>Select the departments this job is expected to visit. Production administrators can change this later.</p><div>{enabledDepartments.map(department=><label key={department.id}><input type="checkbox" name={`route-${department.id}`} defaultChecked/><span>{department.order}</span><b>{department.name}</b></label>)}</div></fieldset>
        <footer className="intake-actions"><button type="reset" className="secondary" disabled={saving} onClick={()=>{setDueDate(localDateValue(3));setJobNumber("");setCreatedJob(null);setLabelPreviewOpenedFor("");setFeedback(null);}}>Clear form</button><button className="primary" disabled={saving}>{saving?"Creating job…":"Create production job"}</button></footer>
      </form><aside className="intake-label-preview"><p className="eyebrow">LABEL PREVIEW</p><h2>Job barcode</h2><p>The Code 128 barcode updates automatically as the job number is entered.</p><div className="intake-paper-label"><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><small>PRODUCTION JOB</small><strong>{previewNumber||"Enter job number"}</strong>{previewNumber?<IntakeBarcode value={previewNumber}/>:<div className="intake-barcode-placeholder">Barcode preview</div>}<p>{createdJob?`${createdJob.customer} · ${createdJob.description}`:previewNumber?"Preview label — the job has not been created yet.":"Enter a job number to preview and print its label."}</p></div><button type="button" className="primary" disabled={!previewNumber} onClick={openPrintPreview}>Print Barcode Label</button>{createdJob&&<small className="intake-label-ready">✓ Job created — this label is ready to print.</small>}</aside></div>
    </main>:<section className="intake-embedded-viewer" aria-label="Production Viewer"><ReadOnlyPortal state={state} embedded themeOverride={portalTheme==="dark"?"graphite":"classic"}/></section>}
    <footer className="intake-footer"><span><i/>Connected to shared PlantFlow production data</span><small>Need additional access? Contact a PlantFlow Super Admin.</small></footer>
    {printPreview&&<div className="reprint-overlay" role="dialog" aria-modal="true" aria-label={`Print barcode for job ${printPreview.jobNumber}`}><div className="reprint-modal"><div className="reprint-head"><div><p className="eyebrow">BARCODE LABEL</p><h2>Job {printPreview.jobNumber}</h2></div><button type="button" aria-label="Close barcode label" onClick={()=>setPrintPreview(null)}>×</button></div><div className="reprint-sheet"><img src={worthHigginsLogo} alt="Worth Higgins & Associates"/><small>PRODUCTION JOB</small><strong>{printPreview.jobNumber}</strong><IntakeBarcode value={printPreview.jobNumber}/><div className="reprint-details">{printPreview.customer&&<b>{printPreview.customer}</b>}{printPreview.description&&<span>{printPreview.description}</span>}<span>Due {new Date(`${printPreview.dueDate}T12:00:00`).toLocaleDateString()}</span></div></div><div className="reprint-actions"><button type="button" className="secondary" onClick={()=>setPrintPreview(null)}>Cancel</button><button type="button" className="primary" onClick={printLabel}>Print Barcode Label</button></div></div></div>}
  </div>;
}
