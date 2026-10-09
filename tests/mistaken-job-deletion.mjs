import {assertFails, assertSucceeds} from '@firebase/rules-unit-testing';
import {doc, setDoc, getDoc, deleteDoc, updateDoc, writeBatch, serverTimestamp} from 'firebase/firestore';
import assert from 'node:assert/strict';

export async function testMistakenJobDeletion(env, service, template) {
  const admin = env.authenticatedContext('admin').firestore();
  const job = {...template, id:'mistake', jobNumber:'MISTAKE', billingState:'review', parts:[]};
  delete job.billingApprovedAt;
  const seed = async (value, count=0) => env.withSecurityRulesDisabled(async ctx => {
    const db=ctx.firestore();
    await setDoc(doc(db,'jobs',value.id),value);
    await setDoc(doc(db,'publicJobs',value.id),value);
    for(let offset=0;offset<count;offset+=400) {
      const batch=writeBatch(db);
      for(let i=offset;i<Math.min(offset+400,count);i++) batch.set(doc(db,'scanEvents',`${value.id}-${i}`),{
        jobNumber:i===0?'OLD-NUMBER':value.jobNumber, ...(i===1?{}:{jobId:value.id}), timestamp:'2026-10-07T00:00:00Z',
      });
      await batch.commit();
    }
  });
  const intent = (value, uid='admin') => ({job:value,jobNumber:value.jobNumber,codes:[value.jobNumber],state:'pending',requestedBy:uid,requestedAt:serverTimestamp(),confirmation:`DELETE ${value.jobNumber}`});
  await seed(job,511);
  await assert.rejects(service.deleteJobPermanently(job,'admin','WRONG'),/phrase/);
  assert.equal((await getDoc(doc(admin,'jobDeletions',job.id))).exists(),false);
  await assertFails(deleteDoc(doc(admin,'jobs',job.id)));
  await assertFails(setDoc(doc(admin,'jobDeletions',job.id),{...intent(job),requestedBy:'someone-else'}));
  await assertFails(setDoc(doc(admin,'jobDeletions',job.id),{...intent(job),confirmation:'DELETE wrong'}));
  await assertFails(setDoc(doc(admin,'jobDeletions',job.id),{...intent(job),job:{...job,notes:'stale'}}));
  for(const [uid,role,enabled] of [['standard-delete','standard',true],['manager-delete','manager',true],['viewer-delete','viewer',true],['disabled-delete','admin',false]]) {
    await env.withSecurityRulesDisabled(ctx=>setDoc(doc(ctx.firestore(),'users',uid),{role,enabled}));
    const db=env.authenticatedContext(uid).firestore();
    await assertFails(setDoc(doc(db,'jobDeletions',job.id),intent(job,uid)));
    await assertFails(getDoc(doc(db,'jobDeletions',job.id)));
  }
  await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(),'jobDeletions',job.id),intent(job)));
  // Another generation using the same barcode must not lose its stable-ID history.
  await setDoc(doc(admin,'scanEvents','other-generation'),{jobId:'different-id',jobNumber:job.jobNumber});
  await service.deleteJobPermanently(job,'admin',`DELETE ${job.jobNumber}`);
  assert.equal((await getDoc(doc(admin,'jobs',job.id))).exists(),false);
  assert.equal((await getDoc(doc(admin,'publicJobs',job.id))).exists(),false);
  for(const i of [0,1,299,450,510]) assert.equal((await getDoc(doc(admin,'scanEvents',`${job.id}-${i}`))).exists(),false);
  assert.equal((await getDoc(doc(admin,'scanEvents','other-generation'))).exists(),true);
  const receipt=(await getDoc(doc(admin,'jobDeletions',job.id))).data();
  assert.equal(receipt.state,'complete'); assert.equal('job' in receipt,false); assert.equal(receipt.completedBy,'admin');
  assert.equal((await getDoc(doc(admin,'deletionHistoryLocks',job.jobNumber))).exists(),false);
  await service.deleteJobPermanently(job,'admin',`DELETE ${job.jobNumber}`); // idempotent
  await assertFails(deleteDoc(doc(admin,'jobDeletions',job.id)));
  await assertFails(updateDoc(doc(admin,'jobDeletions',job.id),{completedBy:'tampered'}));
  await assertFails(setDoc(doc(admin,'jobs',job.id),job));
  await assertFails(setDoc(doc(admin,'publicJobs',job.id),job));
  await assertSucceeds(setDoc(doc(admin,'jobs','new-generation'),{...job,id:'new-generation'}));
  // Interrupted cleanup: keep source visible/frozen and let a later admin resume.
  const interrupted={...job,id:'interrupted-delete',jobNumber:'RETRY-DELETE'};
  await seed(interrupted,11);
  const start=writeBatch(admin);
  start.set(doc(admin,'jobDeletions',interrupted.id),intent(interrupted));
  start.set(doc(admin,'deletionHistoryLocks',interrupted.jobNumber),{jobId:interrupted.id});
  await assertSucceeds(start.commit());
  await assertFails(updateDoc(doc(admin,'jobs',interrupted.id),{status:'Complete'}));
  await assertFails(updateDoc(doc(admin,'publicJobs',interrupted.id),{status:'Complete'}));
  await assertFails(setDoc(doc(admin,'scanEvents','late-id'),{jobNumber:'RENAMED',jobId:interrupted.id}));
  await assertFails(setDoc(doc(admin,'scanEvents','late-legacy'),{jobNumber:interrupted.jobNumber}));
  await assertFails(setDoc(doc(admin,'jobs','reuse-too-early'),{...interrupted,id:'reuse-too-early'}));
  await assertFails(updateDoc(doc(admin,'jobDeletions',interrupted.id),{state:'complete',completedBy:'admin',completedAt:serverTimestamp()}));
  await assertSucceeds(deleteDoc(doc(admin,'scanEvents',`${interrupted.id}-0`)));
  await service.deleteJobPermanently(interrupted,'admin',`DELETE ${interrupted.jobNumber}`);
  assert.equal((await getDoc(doc(admin,'jobs',interrupted.id))).exists(),false);
  // Existing archived billing snapshots and protected source history stay untouched.
  await assert.rejects(service.deleteJobPermanently(template,'admin',`DELETE ${template.jobNumber}`),/archives/);
  await assertFails(setDoc(doc(admin,'jobDeletions',template.id),intent(template)));
  assert.equal((await getDoc(doc(admin,'archivedJobs',template.id))).exists(),true);
  const approved={...job,id:'approved-mistake',billingState:'approved'};
  await seed(approved);
  await assert.rejects(service.deleteJobPermanently(approved,'admin',`DELETE ${approved.jobNumber}`),/OK to bill/);
  await assertFails(setDoc(doc(admin,'jobDeletions',approved.id),intent(approved)));
  const split={...job,id:'split-delete',jobNumber:'SPLIT-DELETE',parts:Array.from({length:26},(_,i)=>({id:`p${i}`,code:`SPLIT-DELETE-${i}`,name:`Part ${i}`,status:'Ready'}))};
  await seed(split);
  await service.deleteJobPermanently(split,'admin',`DELETE ${split.jobNumber}`);
  assert.equal((await getDoc(doc(admin,'jobs',split.id))).exists(),false);
  await assert.rejects(service.clearAllJobData(),/DELETE ALL JOBS/);
  await assert.rejects(service.clearAllJobData('admin','DELETE ALL JOBS'),/OK to bill/);
  assert.equal((await getDoc(doc(admin,'jobs',approved.id))).exists(),true);
  console.log('PASS: explicit admin deletion, 511-event cleanup, receipt integrity, typed confirmation, denied roles, archived/approved protection, interrupted retry, stale-client blocking, safe job-number reuse.');
}
