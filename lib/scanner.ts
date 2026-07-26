export type ParseResult = {ok:true;prefix:string;jobNumber:string}|{ok:false;error:string};
export function parseScannerInput(raw:string):ParseResult {
  const cleaned=raw.trim().toUpperCase();
  if(!cleaned) return {ok:false,error:"The scan was empty."};
  const separator=cleaned.indexOf("|");
  if(separator<1||separator===cleaned.length-1) return {ok:false,error:"Use DEPARTMENT|JOBNUMBER, for example PRINT|590036."};
  const prefix=cleaned.slice(0,separator).trim();
  const jobNumber=cleaned.slice(separator+1).trim();
  if(!/^[A-Z0-9_-]+$/.test(prefix)||!/^[A-Z0-9_:-]+$/.test(jobNumber)) return {ok:false,error:"The scan contains unexpected characters."};
  return {ok:true,prefix,jobNumber};
}
