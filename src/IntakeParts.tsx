export type PartDraft = {name:string;description:string;quantity:string};
export const initialParts = ():PartDraft[] => [{name:"Part A",description:"",quantity:""},{name:"Part B",description:"",quantity:""}];

export function IntakeParts({enabled,onToggle,parts,onChange,jobNumber}:{enabled:boolean;onToggle:(value:boolean)=>void;parts:PartDraft[];onChange:(parts:PartDraft[])=>void;jobNumber:string}) {
  return <fieldset className="create-split-section">
    <div className="create-split-toggle"><div><h3>Does this job need separate tracked parts?</h3><p>Turn this on when portions of the job will move independently. Each part gets its own barcode.</p></div><label className="switch"><input type="checkbox" aria-label="Create separate tracked parts" checked={enabled} onChange={e=>onToggle(e.target.checked)}/><span/></label></div>
    {enabled&&<><div className="create-part-list">{parts.map((part,index)=><div className="create-part-row" key={index}>
      <span className="create-part-code">{jobNumber||"JOB"}-{String.fromCharCode(65+index)}</span>
      {(["name","description","quantity"] as const).map(field=><label key={field}><span>{field==="name"?"Part name *":field==="description"?"Description":"Quantity"}</span><input required={field==="name"} value={part[field]} onChange={e=>onChange(parts.map((item,i)=>i===index?{...item,[field]:e.target.value}:item))}/></label>)}
      {parts.length>2&&<button type="button" aria-label={`Remove ${part.name}`} onClick={()=>onChange(parts.filter((_,i)=>i!==index))}>×</button>}
    </div>)}</div><button type="button" className="add-create-part" disabled={parts.length>=26} onClick={()=>onChange([...parts,{name:`Part ${String.fromCharCode(65+parts.length)}`,description:"",quantity:""}])}>+ Add another part</button></>}
  </fieldset>;
}
