import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,updateDoc,serverTimestamp,writeBatch,setLogLevel} from 'firebase/firestore';
import {readFileSync} from 'node:fs';
setLogLevel('silent');
const env=await initializeTestEnvironment({projectId:'demo-access-hardening',firestore:{host:'127.0.0.1',port:8187,rules:readFileSync('firestore.rules','utf8')}});
try {
 await env.clearFirestore();
 const roles=['super_admin','admin','standard','job_creator','manager','viewer'];
 await env.withSecurityRulesDisabled(async ctx=>{for(const role of roles)await setDoc(doc(ctx.firestore(),'users',role),{role,enabled:true});await setDoc(doc(ctx.firestore(),'users','removed'),{role:'admin',enabled:true,removed:true});for(const c of ['jobs','publicJobs'])await setDoc(doc(ctx.firestore(),c,'job'),{jobNumber:'123',dueDate:'2026-10-12',status:'Ready for Production'});});
 for(const role of roles){const db=env.authenticatedContext(role).firestore();
   await assertSucceeds(updateDoc(doc(db,'users',role),{lastSignInAt:serverTimestamp()}));
   if(role!=='super_admin'){
     await assertFails(updateDoc(doc(db,'users',role),{role:'super_admin'}));
     await assertFails(updateDoc(doc(db,'users',role),{lastSignInAt:'forged'}));
   }
 }
 const floor=env.authenticatedContext('standard').firestore();
 await assertSucceeds(updateDoc(doc(floor,'jobs','job'),{status:'In Production'}));
 for(const field of ['billingState','billingNote','billingApprovedAt','billingClearedAt','dueDate'])await assertFails(updateDoc(doc(floor,'jobs','job'),{[field]:'forged'}));
 await assertFails(updateDoc(doc(floor,'publicJobs','job'),{dueDate:'2027-01-01'}));
 const batch=writeBatch(floor);batch.update(doc(floor,'jobs','job'),{status:'Complete'});batch.delete(doc(floor,'publicJobs','job'));await assertSucceeds(batch.commit());
 for(const role of ['manager','viewer','removed'])await assertFails(getDoc(doc(env.authenticatedContext(role).firestore(),'jobs','job')));
 await assertSucceeds(updateDoc(doc(env.authenticatedContext('admin').firestore(),'jobs','job'),{billingState:'approved',dueDate:'2026-10-13'}));
 console.log('PASS: timestamps only, no privilege escalation, floor status/completion preserved, billing/due-date tampering denied, legacy and removed roles denied, admin billing preserved.');
}finally{await env.cleanup();}
