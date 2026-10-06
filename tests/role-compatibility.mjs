import {initializeTestEnvironment} from '../../archive-validation/node_modules/@firebase/rules-unit-testing/dist/esm/index.esm.js';
import {doc,setDoc,getDoc,deleteDoc,updateDoc} from '../../archive-validation/node_modules/firebase/firestore/dist/index.mjs';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const results=[];
for(const rules of ['tests/published-baseline.rules','firestore.rules']){
 const env=await initializeTestEnvironment({projectId:'demo-plantflow-archive',firestore:{host:'127.0.0.1',port:8187,rules:readFileSync(rules,'utf8')}});await env.clearFirestore();
 const roles=['super_admin','admin','manager','standard','viewer','job_creator','disabled','anonymous'];
 await env.withSecurityRulesDisabled(async ctx=>{for(const role of roles)await setDoc(doc(ctx.firestore(),'users',role),{role,enabled:role!=='disabled'});await setDoc(doc(ctx.firestore(),'configuration','plantflow'),{settings:{}});});
 const observed={};
 for(const role of roles){const db=role==='anonymous'?env.unauthenticatedContext().firestore():env.authenticatedContext(role).firestore();
  const source={id:role,jobNumber:`ROLE-${role}`,dueDate:'2026-10-01',priority:'Standard',createdBy:role};
  const check=async(name,action)=>{try{await action();observed[`${role}:${name}`]=true;}catch(error){assert.equal(error.code,'permission-denied');observed[`${role}:${name}`]=false;}};
  for(const collection of ['jobs','publicJobs']){
   const ref=doc(db,collection,role);await check(`${collection}:create`,()=>setDoc(ref,source));
   await env.withSecurityRulesDisabled(ctx=>setDoc(doc(ctx.firestore(),collection,role),source));
   await check(`${collection}:read`,()=>getDoc(ref));await check(`${collection}:priority`,()=>updateDoc(ref,{priority:'Rush'}));await check(`${collection}:due`,()=>updateDoc(ref,{dueDate:'2026-11-01'}));await check(`${collection}:people`,()=>updateDoc(ref,{customerRepresentative:'Test Rep',projectManager:'Test Manager',savedCustomerRepresentatives:['Test Rep'],savedProjectManagers:['Test Manager']}));await check(`${collection}:delete`,()=>deleteDoc(ref));
  }
  await check('config:read',()=>getDoc(doc(db,'configuration','plantflow')));await check('config:writeNames',()=>setDoc(doc(db,'configuration','jobPeople'),{customerRepresentatives:['Test Rep'],projectManagers:['Test Manager']}));
 }
 results.push(observed);await env.cleanup();
}
assert.deepEqual(results[1],results[0]);
assert.equal(results[1]['standard:jobs:create'],true);assert.equal(results[1]['standard:jobs:delete'],true);assert.equal(results[1]['standard:jobs:priority'],true);assert.equal(results[1]['standard:jobs:due'],false);assert.equal(results[1]['standard:publicJobs:due'],true);assert.equal(results[1]['job_creator:jobs:create'],false);assert.equal(results[1]['job_creator:config:read'],false);
console.log(`PASS: ${Object.keys(results[0]).length} ordinary-access outcomes match the verified published baseline across eight roles; independent people fields require no expanded permissions.`);
