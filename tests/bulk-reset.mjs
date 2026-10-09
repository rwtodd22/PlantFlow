import {initializeTestEnvironment} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,getDocs,collection,setLogLevel} from 'firebase/firestore';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
setLogLevel('silent');
const env=await initializeTestEnvironment({projectId:'demo-bulk-reset',firestore:{host:'127.0.0.1',port:8187,rules:readFileSync('firestore.rules','utf8')}});
try {
 await env.clearFirestore();
 const db=env.authenticatedContext('admin').firestore();globalThis.bulkDb=db;
 mkdirSync('tests/generated-bulk',{recursive:true});
 writeFileSync('tests/generated-bulk/db.mjs','export const db=globalThis.bulkDb;');
 for(const file of ['dataService','jobPeople','returnToProduction','scanTransition','cloudDataService']){
   let source=readFileSync(`lib/${file}.ts`,'utf8').replace('"../src/firebase"','"./db.mjs"').replace('"./dataService"','"./dataService.mjs"').replace('"./jobPeople"','"./jobPeople.mjs"').replace("'./returnToProduction'","'./returnToProduction.mjs'");
   source=source.replace(/(["'])\.\/scanTransition\1/g,'"./scanTransition.mjs"');
   writeFileSync(`tests/generated-bulk/${file}.mjs`,ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
 }
 const {cloudDataService:service}=await import('./generated-bulk/cloudDataService.mjs');
 await env.withSecurityRulesDisabled(async ctx=>{
   const db=ctx.firestore();await setDoc(doc(db,'users','admin'),{role:'super_admin',enabled:true});
   await setDoc(doc(db,'configuration','plantflow'),{keep:true});
   await setDoc(doc(db,'archivedJobs','archive'),{keep:true});
   await setDoc(doc(db,'scanEvents','archive-history'),{jobNumber:'ARCHIVE',jobId:'archive'});
   for(const id of ['one','two']){const job={id,jobNumber:id,parts:[],billingState:id==='two'?'approved':'review'};await setDoc(doc(db,'jobs',id),job);await setDoc(doc(db,'publicJobs',id),job);await setDoc(doc(db,'scanEvents',id),{jobId:id,jobNumber:id});}
 });
 await assert.rejects(service.clearAllJobData('admin','wrong'),/DELETE ALL JOBS/);
 await assert.rejects(service.clearAllJobData('admin','DELETE ALL JOBS'),/No jobs were deleted/);
 assert.equal((await getDocs(collection(db,'jobs'))).size,2);
 await setDoc(doc(db,'jobs','two'),{billingState:'review'},{merge:true});
 await env.withSecurityRulesDisabled(ctx=>setDoc(doc(ctx.firestore(),'users','admin'),{role:'admin',enabled:true}));
 await assert.rejects(service.clearAllJobData('admin','DELETE ALL JOBS'),/Only a Super Admin/);
 await env.withSecurityRulesDisabled(ctx=>setDoc(doc(ctx.firestore(),'users','admin'),{role:'super_admin',enabled:true}));
 const progress=[];
 const result=await service.clearAllJobData('admin','DELETE ALL JOBS',(done,total,job)=>progress.push({done,total,job}));assert.equal(result.deleted,2);
 assert.deepEqual(progress.at(-1),{done:2,total:2,job:''});
 assert.equal((await getDocs(collection(db,'jobs'))).size,0);
 assert.equal((await getDocs(collection(db,'publicJobs'))).size,0);
 assert.equal((await getDocs(collection(db,'scanEvents'))).size,1);
 for(const [c,id] of [['archivedJobs','archive'],['configuration','plantflow'],['users','admin']])assert.equal((await getDoc(doc(db,c,id))).exists(),true);
 assert.equal((await service.clearAllJobData('admin','DELETE ALL JOBS')).deleted,0);
 console.log('PASS: typed confirmation, approved-job preflight, protected bulk cleanup, archive/history/settings/users retained, empty retry.');
}finally{await env.cleanup();}
