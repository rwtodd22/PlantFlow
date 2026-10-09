export type ScanReceipt={id:string;jobId:string;code:string;prefix:string;statusId?:string;scannedAt:string};
type Entry={item:ScanReceipt;error?:string};
export function durableScanQueue(storage:Storage, owner:string, save:(item:ScanReceipt)=>Promise<unknown>, report:(pending:number,failures:string[])=>void) {
  const prefix="plantflow-scans-v1:"+owner+":";
  let running=false,stopped=false;
  const entries=()=>Object.keys(storage).filter(key=>key.startsWith(prefix)).map(key=>({key,...JSON.parse(storage.getItem(key)!) as Entry})).sort((a,b)=>a.item.scannedAt.localeCompare(b.item.scannedAt)||a.item.id.localeCompare(b.item.id));
  const refresh=()=>{const all=entries();report(all.filter(e=>!e.error).length,all.filter(e=>e.error).map(e=>e.item.code+": "+e.error));};
  const drain=async()=>{
    if(running||stopped)return;
    running=true;
    try{
      for(const entry of entries()){
        if(stopped)break;
        if(entry.error)continue;
        try{await save(entry.item);storage.removeItem(entry.key);}
        catch(error){
          const code=String((error as {code?:string})?.code||"").replace("firestore/","");
          if(["unavailable","deadline-exceeded","aborted","resource-exhausted","internal","unknown"].includes(code))break;
          storage.setItem(entry.key,JSON.stringify({item:entry.item,error:error instanceof Error?error.message:"Save failed; review this scan."}));
        }
      }
    }finally{running=false;refresh();}
  };
  return {
    add(item:ScanReceipt){if(entries().length>=1000)throw Error("Device scan storage is full. Resolve pending scans first.");storage.setItem(prefix+item.id,JSON.stringify({item}));refresh();void drain();},
    start(){stopped=false;refresh();void drain();},
    stop(){stopped=true;},
    sync(){void drain();},
    dismiss(){for(const e of entries())if(e.error)storage.removeItem(e.key);refresh();},
  };
}
