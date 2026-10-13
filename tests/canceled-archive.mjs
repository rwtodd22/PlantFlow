import assert from 'node:assert/strict';
import {archiveCanceledJob,isCanceledJob} from '../functions/canceledArchive.js';
const statuses=[{name:'Canceled',code:'CANCELED'},{name:'Complete',code:'COMPLETE'}];
assert.equal(isCanceledJob({status:'Complete'},statuses),false);
assert.equal(isCanceledJob({status:'Canceled'},statuses),true);
assert.equal(isCanceledJob({status:'Canceled',parts:[{status:'Complete'},{status:'Canceled'}]},statuses),false);
assert.equal(isCanceledJob({parts:[{status:'Canceled'},{status:'Canceled'}]},statuses),true);
assert.equal(isCanceledJob({status:'Stopped'},[{name:'Stopped',code:'CANCELED'}]),true);

// Small Firestore double exercises the real move/capture workflow without live data.
const records=new Map();
let failCapture=false;
const snapshot=path=>({exists:records.has(path),id:path.split('/').at(-1),data:()=>records.get(path)});
const doc=path=>({path,get:async()=>snapshot(path),collection:name=>collection(`${path}/${name}`)});
function collection(path,filters=[],cursor='',size=Infinity){return {
  doc:id=>doc(`${path}/${id}`),
  where:(key,op,value)=>collection(path,[...filters,data=>op==='in'?value.includes(data[key]):data[key]===value],cursor,size),
  orderBy:()=>collection(path,filters,cursor,size),limit:n=>collection(path,filters,cursor,n),startAfter:s=>collection(path,filters,s.id,size),
  async get(){const docs=[...records.keys()].filter(key=>key.startsWith(path+'/')&&!key.slice(path.length+1).includes('/')).sort().map(snapshot).filter(s=>s.id>cursor&&filters.every(f=>f(s.data()))).slice(0,size);return {docs,size:docs.length};},
  count(){return {get:async()=>{const result=await collection(path).get();return {data:()=>({count:result.size})};}};},
};}
function writer(){const operations=[];return {get:async ref=>snapshot(ref.path),create(ref,data){assert.ok(!records.has(ref.path));operations.push(()=>records.set(ref.path,data));},set(ref,data){operations.push(()=>records.set(ref.path,data));},delete(ref){operations.push(()=>records.delete(ref.path));},update(ref,data){operations.push(()=>records.set(ref.path,{...records.get(ref.path),...data}));},async commit(){operations.forEach(f=>f());}};}
const db={doc,collection,async runTransaction(fn){const tx=writer();await fn(tx);await tx.commit();},batch(){if(failCapture){failCapture=false;throw new Error('Simulated outage');}return writer();}};
records.set('configuration/plantflow',{statuses,departments:[]});
const job={id:'test',jobNumber:'123',status:'Canceled',notes:'Preserved',parts:[{code:'123-A',status:'Canceled'}]};
records.set('jobs/test',job);records.set('publicJobs/test',job);
records.set('scanEvents/one',{jobId:'test',jobNumber:'OLD'});
records.set('scanEvents/two',{jobNumber:'123-A'});
records.set('scanEvents/other',{jobId:'different',jobNumber:'123'});
failCapture=true;
await assert.rejects(archiveCanceledJob(db,'test',()=>123),/Simulated outage/);
assert.equal(records.has('jobs/test'),false);
assert.equal(records.has('publicJobs/test'),false);
assert.equal(records.get('archivedJobs/test').historyStatus,'capturing');
assert.ok(records.has('archiveHistoryLocks/123'));
await archiveCanceledJob(db,'test',()=>456);
assert.deepEqual(records.get('archivedJobs/test').job,job);
assert.equal(records.get('archivedJobs/test').archivedAt,123);
assert.equal(records.get('archivedJobs/test').historyStatus,'complete');
assert.equal(records.get('archivedJobs/test').historyEventCount,2);
assert.equal(records.has('archiveHistoryLocks/123'),false);
assert.ok(records.has('scanEvents/one'));
await archiveCanceledJob(db,'test',()=>789);
assert.equal(records.get('archivedJobs/test').archivedAt,123);
for(const status of ['Complete','In Production']){records.set('jobs/keep',{...job,id:'keep',status,parts:[]});await archiveCanceledJob(db,'keep',()=>123);assert.ok(records.has('jobs/keep'));assert.equal(records.has('archivedJobs/keep'),false);}
records.set('jobs/deleting',{...job,id:'deleting'});records.set('jobDeletions/deleting',{});
await archiveCanceledJob(db,'deleting',()=>123);
assert.ok(records.has('jobs/deleting'));assert.equal(records.has('archivedJobs/deleting'),false);
records.set('jobs/locked',{...job,id:'locked'});records.set('archiveHistoryLocks/123',{archiveId:'another'});
await assert.rejects(archiveCanceledJob(db,'locked',()=>123),/already locked/);
assert.ok(records.has('jobs/locked'));assert.equal(records.has('archivedJobs/locked'),false);
console.log('PASS: canceled-only policy, split jobs, full record preservation, history isolation, interrupted capture recovery, and idempotent retries.');
