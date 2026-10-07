import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,getDocs,collection,writeBatch,serverTimestamp,deleteDoc} from 'firebase/firestore';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
const projectId='demo-plantflow-archive';
const env=await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port:8187,rules:readFileSync('firestore.rules','utf8')}});
await env.clearFirestore();
const admin=env.authenticatedContext('admin').firestore();globalThis.archiveTestDb=admin;
mkdirSync('tests/generated',{recursive:true});
writeFileSync('tests/generated/db.mjs','export const db=globalThis.archiveTestDb;');
for(const file of ['dataService','jobPeople','returnToProduction','cloudDataService']){let source=readFileSync(`lib/${file}.ts`,'utf8');source=source.replace('"../src/firebase"','"./db.mjs"').replace('"./dataService"','"./dataService.mjs"').replace('"./jobPeople"','"./jobPeople.mjs"').replace("'./returnToProduction'","'./returnToProduction.mjs'");writeFileSync(`tests/generated/${file}.mjs`,ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);}
const {cloudDataService:service}=await import('./generated/cloudDataService.mjs');
const {seedState}=await import('./generated/dataService.mjs');
const job={...seedState.jobs[0],id:'job-one',customerRepresentative:'Test Representative',projectManager:'Test Manager',status:'Complete',billingState:'approved',billingApprovedAt:'2026-10-01T00:00:00Z',notes:'Original production notes',billingNote:'PO 123',parts:[{id:'part-a',code:'590036-A',name:'Panel',description:'Full details',quantity:'3',currentDepartmentId:'ship',status:'Complete',updatedAt:'2026-10-01T00:00:00Z'}]};
await env.withSecurityRulesDisabled(async ctx=>{const db=ctx.firestore();await setDoc(doc(db,'users','admin'),{enabled:true,role:'admin'});await setDoc(doc(db,'users','worker'),{enabled:true,role:'standard'});await setDoc(doc(db,'configuration','plantflow'),{departments:seedState.departments,statuses:seedState.statuses,settings:seedState.settings});await setDoc(doc(db,'jobs',job.id),job);await setDoc(doc(db,'publicJobs',job.id),job);await setDoc(doc(db,'scanEvents','event-one'),{id:'event-one',jobNumber:job.jobNumber,timestamp:'2026-10-01T00:00:00Z'});});
await service.archiveJob(job.id,'admin');
assert.equal((await getDoc(doc(admin,'jobs',job.id))).exists(),false);assert.equal((await getDoc(doc(admin,'publicJobs',job.id))).exists(),false);
const saved=(await getDoc(doc(admin,'archivedJobs',job.id))).data();assert.deepEqual(saved.job,job);assert.equal((await getDoc(doc(admin,'scanEvents','event-one'))).exists(),true);
assert.deepEqual((await getDoc(doc(admin,"configuration","jobPeople"))).data(),{customerRepresentatives:["Test Representative"],projectManagers:["Test Manager"]});
await service.archiveJob(job.id,'admin'); // idempotent retry
await assertFails(setDoc(doc(admin,'jobs',job.id),job));await assertFails(setDoc(doc(admin,'publicJobs',job.id),job));await assertFails(deleteDoc(doc(admin,'archivedJobs',job.id)));await assertFails(setDoc(doc(admin,'archivedJobs',job.id),{...saved,job:{...job,notes:'tampered'}}));
await assertFails(getDocs(collection(env.authenticatedContext('worker').firestore(),'archivedJobs')));await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(),'archivedJobs')));
await env.withSecurityRulesDisabled(async ctx=>{const db=ctx.firestore();await setDoc(doc(db,'jobs','held'),{...job,id:'held',billingState:'hold'});await setDoc(doc(db,'jobs','active'),{...job,id:'active',status:'In Production',parts:[]});for(let i=0;i<51;i++)await setDoc(doc(db,'archivedJobs',`page-${i}`),{...saved,job:{...job,id:`page-${i}`,jobNumber:`P${String(i).padStart(3,'0')}`,customer:i%2?'Zebra':'Acme'}});});
await assert.rejects(service.archiveJob('held','admin'),/OK to bill/);await assert.rejects(service.archiveJob('active','admin'),/completed/);assert.equal((await getDoc(doc(admin,'jobs','held'))).exists(),true);
for(const sort of ['newest','oldest','job','customer']){let cursor;let ids=[];do{const page=await service.loadArchivedJobs(sort,cursor);assert.ok(page.records.length<=25);ids.push(...page.records.map(record=>record.id));cursor=page.hasMore?page.cursor:undefined;}while(cursor);assert.equal(ids.length,52);assert.equal(new Set(ids).size,52);}
// Archive creation must copy exactly and remove the original in the same commit.
await assertFails(setDoc(doc(admin,'archivedJobs','held'),{...saved,job:{...job,id:'held'},archivedAt:serverTimestamp(),archivedBy:'admin'}));
// A refused archive batch must leave the source untouched.
await env.withSecurityRulesDisabled(async ctx=>{await setDoc(doc(ctx.firestore(),'jobs','atomic'),{...job,id:'atomic',notes:'Latest server note'});});
const archiveBatch=writeBatch(admin);archiveBatch.set(doc(admin,'archivedJobs','atomic'),{...saved,job:{...job,id:'atomic',notes:'Stale browser note'},archivedAt:serverTimestamp(),archivedBy:'admin'});archiveBatch.delete(doc(admin,'jobs','atomic'));await assertFails(archiveBatch.commit());assert.equal((await getDoc(doc(admin,'jobs','atomic'))).data().notes,'Latest server note');
const worker=env.authenticatedContext('worker').firestore();const workerBatch=writeBatch(worker);workerBatch.set(doc(worker,'archivedJobs','atomic'),{...saved,job:{...job,id:'atomic',notes:'Latest server note'},archivedAt:serverTimestamp(),archivedBy:'worker'});workerBatch.delete(doc(worker,'jobs','atomic'));await assertFails(workerBatch.commit());
await service.archiveJob('atomic','admin');assert.equal((await getDoc(doc(admin,'archivedJobs','atomic'))).data().job.notes,'Latest server note');
// Capture over 300 events, including stable-ID events under an old barcode.
const bulk={...job,id:'bulk',jobNumber:'BULK',parts:[],status:'Complete'};
await env.withSecurityRulesDisabled(async ctx=>{const db=ctx.firestore();await setDoc(doc(db,'jobs','bulk'),bulk);const batch=writeBatch(db);for(let i=0;i<321;i++)batch.set(doc(db,'scanEvents',`bulk-${String(i).padStart(3,'0')}`),{id:`bulk-${i}`,jobId:'bulk',jobNumber:i<5?'OLD-BULK':'BULK',departmentId:i%2?'lam':'print',previousDepartmentId:i%2?'print':'lam',departmentName:'Department',timestamp:'2026-10-01T00:00:00Z',type:'Normal'});batch.set(doc(db,'scanEvents','bulk-legacy'),{id:'bulk-legacy',jobNumber:'BULK',departmentId:'print',previousDepartmentId:'',departmentName:'Printing',timestamp:'2026-10-01T00:00:00Z',type:'Normal'});await batch.commit();});
const finish=service.finishArchiveHistory;
service.finishArchiveHistory=async()=>{throw new Error('Simulated interruption after atomic move');};
await assert.rejects(service.archiveJob('bulk','admin'),/Simulated interruption/);service.finishArchiveHistory=finish;
assert.equal((await getDoc(doc(admin,'archivedJobs','bulk'))).data().historyStatus,'capturing');assert.equal((await getDoc(doc(admin,'jobs','bulk'))).exists(),false);
await assertFails(setDoc(doc(admin,'scanEvents','blocked-new'),{jobNumber:'BULK',timestamp:'2026-10-02T00:00:00Z'}));await assertFails(deleteDoc(doc(admin,'scanEvents','bulk-legacy')));await assertFails(setDoc(doc(admin,'jobs','reuse-bulk'),{...bulk,id:'reuse-bulk'}));
// A partially written event page is safe to overwrite identically on retry.
const originalEvent=(await getDoc(doc(admin,'scanEvents','bulk-000'))).data();await setDoc(doc(admin,'archivedJobs','bulk','events','bulk-000'),originalEvent);
await service.finishArchiveHistory('bulk');await service.finishArchiveHistory('bulk');
const captured=(await getDoc(doc(admin,'archivedJobs','bulk'))).data();assert.equal(captured.historyStatus,'complete');assert.equal(captured.historyEventCount,322);assert.equal((await getDoc(doc(admin,'archiveHistoryLocks','BULK'))).exists(),false);
const completeHistory=await service.loadArchiveHistory('bulk');assert.equal(completeHistory.length,322);assert.equal(new Set(completeHistory.map(event=>event.id)).size,322);assert.equal(completeHistory.filter(event=>event.jobNumber==='OLD-BULK').length,5);
await assertFails(deleteDoc(doc(admin,'archivedJobs','bulk','events','bulk-000')));await assertFails(setDoc(doc(admin,'archivedJobs','bulk','events','bulk-000'),{...originalEvent,departmentId:'tampered'}));
// Legacy source mutation after capture does not change the preserved archive.
await deleteDoc(doc(admin,'scanEvents','bulk-legacy'));assert.equal((await service.loadArchiveHistory('bulk')).length,322);
const liveHistory=await service.loadJobHistory(bulk);assert.equal(liveHistory.length,321);
console.log('PASS: 322-event full capture; stable-ID old barcode inclusion; interruption recovery; pending locks; blocked mutation/reuse while capturing; idempotent partial-page replay; immutable copied events; archived history survives later legacy-source removal.');
console.log('PASS: rules compile; atomic rejection preserves source; fresh server details; unauthorized writes denied; exact full-record archive; active/public removal; history retained; idempotent retry; archived record immutable; stale recreation denied; unauthorized reads denied; held/active jobs rejected; all four sorts paginate 52 records including equal timestamp ties.');
// Real service create and edit persist distinct rosters, including previous values.
const named={...seedState.jobs[0],id:'people-test',jobNumber:'PEOPLE',customerRepresentative:'Rep Alpha',projectManager:'Manager Beta'};
await service.createJobFromIntake(named,true);
const created=(await getDoc(doc(admin,'jobs',named.id))).data();
assert.equal(created.customerRepresentative,'Rep Alpha');assert.equal(created.projectManager,'Manager Beta');
const edited={...created,customerRepresentative:'Rep Gamma'};
await service.saveChanges({...seedState,jobs:[created],scans:[]},{...seedState,jobs:[edited],scans:[]},'admin',true);
const persisted=(await getDoc(doc(admin,'jobs',named.id))).data();
assert.deepEqual(persisted.savedCustomerRepresentatives,['Rep Alpha','Rep Gamma']);assert.deepEqual(persisted.savedProjectManagers,['Manager Beta']);
const roster=(await getDoc(doc(admin,'configuration','jobPeople'))).data();assert.ok(roster.customerRepresentatives.includes('Rep Gamma'));assert.ok(!roster.projectManagers.includes('Rep Gamma'));
// Non-admin edits retain prior names on the job without changing config permissions.
await service.saveChanges({...seedState,jobs:[persisted],scans:[]},{...seedState,jobs:[{...persisted,projectManager:'Manager Delta'}],scans:[]},'admin',false);
assert.deepEqual((await getDoc(doc(admin,'jobs',named.id))).data().savedProjectManagers,['Manager Beta','Manager Delta']);
console.log('PASS: service create/edit persistence, independent names, prior-name reuse, and no-config-write path.');
// Old Clear / 90-day cleanup batches are denied atomically, even if queued earlier.
const expired={...job,id:'old-expired',jobNumber:'OLD-EXPIRED',parts:[],billingApprovedAt:'2025-01-01T00:00:00Z'};
const untouched={...seedState.jobs[0],id:'unrelated',jobNumber:'UNRELATED'};
await env.withSecurityRulesDisabled(async ctx=>{for(const collectionName of ['jobs','publicJobs']){await setDoc(doc(ctx.firestore(),collectionName,expired.id),expired);await setDoc(doc(ctx.firestore(),collectionName,untouched.id),untouched);}});
for(const label of ['manual-clear','queued-90-day']){const oldBatch=writeBatch(admin);oldBatch.delete(doc(admin,'jobs',expired.id));oldBatch.delete(doc(admin,'publicJobs',expired.id));oldBatch.set(doc(admin,'jobs',untouched.id),{...untouched,notes:label});await assertFails(oldBatch.commit());assert.deepEqual((await getDoc(doc(admin,'jobs',expired.id))).data(),expired);assert.deepEqual((await getDoc(doc(admin,'publicJobs',expired.id))).data(),expired);assert.deepEqual((await getDoc(doc(admin,'jobs',untouched.id))).data(),untouched);}
// Normal scan writes and public cleanup still work; direct reset deletion does not.
await assertSucceeds(setDoc(doc(worker,'scanEvents','normal-scan'),{jobNumber:'UNRELATED',jobId:'unrelated',timestamp:'2026-10-06T00:00:00Z',type:'Normal'}));
await assertSucceeds(setDoc(doc(worker,'jobs','unrelated'),{...untouched,currentDepartmentId:'print'}));await assertSucceeds(deleteDoc(doc(worker,'publicJobs','unrelated')));
const resetBatch=writeBatch(admin);resetBatch.delete(doc(admin,'jobs',expired.id));resetBatch.delete(doc(admin,'jobs','unrelated'));await assertFails(resetBatch.commit());assert.equal((await getDoc(doc(admin,'jobs','unrelated'))).exists(),true);
// Existing old Reset clears collections sequentially: source scan deletion is still allowed.
// This deliberately verifies the limit of a jobs-only safeguard, not a whole-reset guarantee.
await assertSucceeds(deleteDoc(doc(admin,'scanEvents','normal-scan')));
assert.equal((await getDoc(doc(admin,'scanEvents','normal-scan'))).exists(),false);
assert.equal((await getDoc(doc(admin,'jobs','unrelated'))).exists(),true);
await service.archiveJob(expired.id,'admin');assert.deepEqual((await getDoc(doc(admin,'archivedJobs',expired.id))).data().job,expired);assert.equal((await getDoc(doc(admin,'jobs',expired.id))).exists(),false);
console.log('PASS: old Clear/queued-cleanup batches denied atomically; current job and public copy retained; unrelated batch writes rolled back; normal scanning/editing/public cleanup allowed; exact-copy archive succeeds; reset job deletion denied. LIMIT: separate legacy reset scan deletion still allowed.');
const {testMistakenJobDeletion}=await import('./mistaken-job-deletion.mjs');
await testMistakenJobDeletion(env,service,job);
const {testProductionReturn}=await import('./return-to-production.mjs');
await testProductionReturn(env,service,job,seedState);
await env.cleanup();
