/** Share concurrent checks (including StrictMode remounts), never cache access decisions. */
export function createStartupRequest<T>(read:(key:string)=>Promise<T>, timeoutMs=12000) {
  const pending=new Map<string,Promise<T>>();
  return (key:string):Promise<T>=>{
    const existing=pending.get(key);
    if(existing)return existing;
    const request=new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('The secure account check is taking too long. Check your connection and try again.')),timeoutMs);
      Promise.resolve().then(()=>read(key)).then(resolve,reject).finally(()=>clearTimeout(timer));
    });
    pending.set(key,request);
    const clear=()=>{if(pending.get(key)===request)pending.delete(key);};
    request.then(clear,clear);
    return request;
  };
}
