export type Department = { id:string; name:string; prefix:string; enabled:boolean; order:number };
export type StatusDefinition = { id:string; name:string; code:string; enabled:boolean; order:number; color:string; closesJob:boolean };
export type Job = { id:string; jobNumber:string; customer:string; description:string; dueDate:string; priority:"Standard"|"Rush"|"Critical"; status:string; currentDepartmentId:string; route:string[]; notes:string; createdAt:string; updatedAt:string };
export type ScanEvent = { id:string; jobNumber:string; departmentId:string; departmentName:string; previousDepartmentId:string; timestamp:string; type:"Normal"|"Route exception"|"Manual"|"Status command"; statusName?:string };
export type AppSettings = { deadlineHighlighting:boolean };
export type AppState = { departments:Department[]; statuses:StatusDefinition[]; settings:AppSettings; jobs:Job[]; scans:ScanEvent[] };

const now = Date.now();
const iso = (minutesAgo:number) => new Date(now-minutesAgo*60000).toISOString();
const date = (days:number) => new Date(now+days*86400000).toISOString().slice(0,10);

export const seedState: AppState = {
  settings:{deadlineHighlighting:true},
  departments:[
    {id:"prepress",name:"Prepress",prefix:"PREPRESS",enabled:true,order:1},{id:"print",name:"Printing",prefix:"PRINT",enabled:true,order:2},{id:"lam",name:"Lamination",prefix:"LAM",enabled:true,order:3},{id:"route",name:"Routing",prefix:"ROUTE",enabled:true,order:4},{id:"paint",name:"Painting",prefix:"PAINT",enabled:true,order:5},{id:"finish",name:"Finishing",prefix:"FINISH",enabled:true,order:6},{id:"assembly",name:"Assembly",prefix:"ASSEMBLY",enabled:true,order:7},{id:"pack",name:"Packaging",prefix:"PACK",enabled:true,order:8},{id:"ship",name:"Shipping",prefix:"SHIP",enabled:true,order:9}
  ],
  statuses:[
    {id:"ready",name:"Ready for Production",code:"READY",enabled:true,order:1,color:"#64748b",closesJob:false},
    {id:"production",name:"In Production",code:"IN_PRODUCTION",enabled:true,order:2,color:"#2f6c86",closesJob:false},
    {id:"hold",name:"On Hold",code:"ON_HOLD",enabled:true,order:3,color:"#b56818",closesJob:false},
    {id:"materials",name:"Waiting for Materials",code:"WAITING_MATERIALS",enabled:true,order:4,color:"#c66a22",closesJob:false},
    {id:"quality",name:"Quality Check",code:"QUALITY_CHECK",enabled:true,order:5,color:"#7657a8",closesJob:false},
    {id:"rework",name:"Rework",code:"REWORK",enabled:true,order:6,color:"#b63833",closesJob:false},
    {id:"complete",name:"Complete",code:"COMPLETE",enabled:true,order:7,color:"#0f7957",closesJob:true},
    {id:"canceled",name:"Canceled",code:"CANCELED",enabled:true,order:8,color:"#6b7280",closesJob:true}
  ],
  jobs:[
    {id:"j1",jobNumber:"590036",customer:"VCU Generations",description:"GEN 1006 — Additional Sign",dueDate:date(1),priority:"Rush",status:"In Production",currentDepartmentId:"print",route:["prepress","print","route","finish","pack","ship"],notes:"",createdAt:iso(700),updatedAt:iso(12)},
    {id:"j2",jobNumber:"590037",customer:"River City Bank",description:"Branch lobby dimensional letters",dueDate:date(0),priority:"Critical",status:"In Production",currentDepartmentId:"route",route:["prepress","print","lam","route","paint","assembly","pack","ship"],notes:"",createdAt:iso(1500),updatedAt:iso(28)},
    {id:"j3",jobNumber:"590038",customer:"Commonwealth Health",description:"Exterior wayfinding sign package",dueDate:date(3),priority:"Standard",status:"Waiting for Materials",currentDepartmentId:"prepress",route:["prepress","print","lam","route","finish","pack","ship"],notes:"",createdAt:iso(2600),updatedAt:iso(245)},
    {id:"j4",jobNumber:"590039",customer:"Cardinal Foods",description:"Fleet graphics — Box truck 04",dueDate:date(-1),priority:"Rush",status:"On Hold",currentDepartmentId:"lam",route:["prepress","print","lam","finish"],notes:"",createdAt:iso(3300),updatedAt:iso(115)},
    {id:"j5",jobNumber:"590040",customer:"Oak & Main",description:"Retail window graphic refresh",dueDate:date(5),priority:"Standard",status:"In Production",currentDepartmentId:"finish",route:["prepress","print","lam","finish","pack","ship"],notes:"",createdAt:iso(800),updatedAt:iso(44)},
  ],
  scans:[
    {id:"s1",jobNumber:"590036",departmentId:"print",departmentName:"Printing",previousDepartmentId:"prepress",timestamp:iso(12),type:"Normal"},
    {id:"s2",jobNumber:"590037",departmentId:"route",departmentName:"Routing",previousDepartmentId:"lam",timestamp:iso(28),type:"Normal"},
    {id:"s3",jobNumber:"590040",departmentId:"finish",departmentName:"Finishing",previousDepartmentId:"lam",timestamp:iso(44),type:"Normal"},
    {id:"s4",jobNumber:"590039",departmentId:"lam",departmentName:"Lamination",previousDepartmentId:"print",timestamp:iso(115),type:"Normal"},
    {id:"s5",jobNumber:"590038",departmentId:"prepress",departmentName:"Prepress",previousDepartmentId:"",timestamp:iso(245),type:"Normal"},
  ]
};

const KEY="plantflow-local-v1";
export const dataService = {
  load():AppState { try { const value=localStorage.getItem(KEY); if(!value)return seedState; const saved=JSON.parse(value); return {...seedState,...saved,statuses:saved.statuses||seedState.statuses,settings:{...seedState.settings,...saved.settings}}; } catch { return seedState; } },
  save(state:AppState) { localStorage.setItem(KEY,JSON.stringify(state)); },
  reset():AppState { localStorage.setItem(KEY,JSON.stringify(seedState)); return structuredClone(seedState); }
};
