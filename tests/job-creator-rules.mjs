import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,getDocs,collection,writeBatch,updateDoc,deleteDoc} from 'firebase/firestore';
import {readFileSync} from 'node:fs';
const env=await initializeTestEnvironment({projectId:'demo-intake-access',firestore:{host:'127.0.0.1',port:8187,rules:readFileSync('firestore.rules','utf8')}});
try {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx=>{
    const db=ctx.firestore();
    for(const [uid,role,enabled] of [['creator','job_creator',true],['disabled','job_creator',false],['viewer','viewer',true]])await setDoc(doc(db,'users',uid),{role,enabled});
    await setDoc(doc(db,'configuration','plantflow'),{departments:[]});
    await setDoc(doc(db,'configuration','jobPeople'),{customerRepresentatives:[]});
    await setDoc(doc(db,'archivedJobs','archive'),{job:{jobNumber:'ARCHIVE'}});
  });
  const db=env.authenticatedContext('creator').firestore();
  await assertSucceeds(getDoc(doc(db,'configuration','plantflow')));
  await assertSucceeds(getDoc(doc(db,'configuration','jobPeople')));
  await assertSucceeds(getDocs(collection(db,'jobs')));
  const job={id:'new',jobNumber:'123',createdBy:'creator',status:'Ready for Production',parts:[{code:'123-A',name:'Part A'}]};
  const batch=writeBatch(db);batch.set(doc(db,'jobs','new'),job);batch.set(doc(db,'publicJobs','new'),job);
  await assertSucceeds(batch.commit());
  await assertFails(updateDoc(doc(db,'jobs','new'),{status:'Complete'}));
  await assertFails(deleteDoc(doc(db,'jobs','new')));
  await assertFails(updateDoc(doc(db,'publicJobs','new'),{status:'Complete'}));
  await assertFails(setDoc(doc(db,'publicJobs','orphan'),{jobNumber:'ORPHAN'}));
  await assertFails(setDoc(doc(db,'jobs','forged'),{...job,id:'forged',createdBy:'admin'}));
  await assertFails(setDoc(doc(db,'jobs','billed'),{...job,id:'billed',billingState:'approved'}));
  await assertFails(setDoc(doc(db,'configuration','jobPeople'),{customerRepresentatives:['New']}));
  await assertFails(getDoc(doc(db,'archivedJobs','archive')));
  await assertFails(getDocs(collection(db,'scanEvents')));
  await assertFails(getDoc(doc(db,'users','viewer')));
  for(const uid of ['disabled','viewer'])await assertFails(setDoc(doc(env.authenticatedContext(uid).firestore(),'jobs','blocked'),{...job,id:'blocked',createdBy:uid}));
  await assertFails(getDocs(collection(env.authenticatedContext('disabled').firestore(),'jobs')));
  console.log('PASS: job creators can load intake and create split jobs; existing jobs, configuration, archives, history, other users, and disabled accounts remain protected.');
}finally{await env.cleanup();}
