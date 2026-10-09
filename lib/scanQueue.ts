/** In-memory FIFO: each receipt captures its command before asynchronous saving. */
export function createScanQueue<T>(save:(item:T)=>Promise<void>, changed:(count:number)=>void, failed:(item:T,error:unknown)=>void) {
  const items:T[]=[];
  let running=false;
  const drain=async()=>{
    if(running)return;
    running=true;
    while(items.length){
      const item=items[0];
      try{await save(item);}catch(error){failed(item,error);}
      items.shift();changed(items.length);
    }
    running=false;
  };
  return {add(item:T){if(items.length>=100)throw new Error("Scanner queue is full. Wait for pending scans to finish.");items.push(item);changed(items.length);void drain();},get count(){return items.length;}};
}
