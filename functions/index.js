import {initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {getFirestore,FieldValue} from "firebase-admin/firestore";
import {onCall,HttpsError} from "firebase-functions/v2/https";
import {resetPolicy} from "./resetPolicy.js";
import {onDocumentWritten,onDocumentCreated} from "firebase-functions/v2/firestore";
import {archiveCanceledJob,finishArchivedHistory} from "./canceledArchive.js";
import {canUseWfBilling,isCompletedWfJob,isApproved} from "./wfBillingPolicy.js";
initializeApp();

export const archiveCanceledJobs=onDocumentWritten({document:"jobs/{jobId}",region:"us-central1",maxInstances:3,retry:true,timeoutSeconds:540},async event=>{
  await archiveCanceledJob(getFirestore(),event.params.jobId,()=>FieldValue.serverTimestamp());
});

export const finishWfPortalArchive=onDocumentCreated({document:"archivedJobs/{jobId}",region:"us-central1",maxInstances:3,retry:true,timeoutSeconds:540},async event=>{
  if(event.data?.data().archiveOrigin==="wf-portal") await finishArchivedHistory(getFirestore(),event.params.jobId,()=>FieldValue.serverTimestamp(),"wf-portal");
});

export const manageWfBilling=onCall({region:"us-central1",maxInstances:3,timeoutSeconds:540},async request=>{
  if(!request.auth) throw new HttpsError("unauthenticated","Please sign in.");
  const db=getFirestore(), uid=request.auth.uid;
  const profileRef=db.doc(`users/${uid}`);
  const authorize=async tx=>{
    const profile=await tx.get(profileRef);
    if(!canUseWfBilling(profile.data())) throw new HttpsError("permission-denied","Completed WF billing access is limited to the designated team members.");
  };
  await authorize({get:ref=>ref.get()});
  const {action,jobId,billingState,billingNote}=request.data||{};
  if(!['update','archive'].includes(action)||typeof jobId!=="string"||!jobId||jobId.includes('/')||jobId==='.'||jobId==='..') throw new HttpsError("invalid-argument","Choose a valid job and action.");
  const validate=(job,statuses)=>{
    if(!isCompletedWfJob(job,statuses)) throw new HttpsError("failed-precondition","Only completed Wide Format jobs can be managed here.");
  };
  if(action==='archive'){
    await archiveCanceledJob(db,jobId,()=>FieldValue.serverTimestamp(),{uid,authorize,validate:(job,statuses)=>{
      validate(job,statuses);
      if(!isApproved(job)) throw new HttpsError("failed-precondition","Mark the job OK to bill before archiving.");
    }});
  }else{
    if(!['awaiting','approved','hold'].includes(billingState)||typeof billingNote!=='string'||billingNote.length>500) throw new HttpsError("invalid-argument","Choose a billing state and a note of at most 500 characters.");
    await db.runTransaction(async tx=>{
      await authorize(tx);
      const ref=db.doc(`jobs/${jobId}`);
      const [source,config,archive,deletion]=await Promise.all([tx.get(ref),tx.get(db.doc('configuration/plantflow')),tx.get(db.doc(`archivedJobs/${jobId}`)),tx.get(db.doc(`jobDeletions/${jobId}`))]);
      if(!source.exists||!config.exists||archive.exists||deletion.exists) throw new HttpsError("failed-precondition","This job is no longer available.");
      validate(source.data(),config.data().statuses);
      tx.update(ref,{billingState,billingNote,billingApprovedAt:billingState==='approved'?new Date().toISOString():FieldValue.delete()});
    });
  }
  return {ok:true};
});

export const resetProductionPasscode=onCall({region:"us-central1",maxInstances:3},async request=>{
  if(!request.auth)throw new HttpsError("unauthenticated","Sign in as a Super Admin.");
  const db=getFirestore(), auth=getAuth();
  const caller=await db.doc("users/"+request.auth.uid).get();
  if(!caller.data()?.enabled||caller.data()?.removed||caller.data()?.role!=="super_admin")throw new HttpsError("permission-denied","Only active Super Admins can reset passcodes.");
  const uid=request.data?.uid;
  if(typeof uid!=="string"||!uid||uid.length>128||uid.includes("/"))throw new HttpsError("invalid-argument","Select a valid employee.");
  const targetRef=db.doc("users/"+uid);
  const target=await targetRef.get();
  const denied=resetPolicy(caller.data(),target.data(),request.data);
  if(denied)throw new HttpsError(denied,denied==="invalid-argument"?"Use a passcode of 8–128 characters.":"Only active Production Floor accounts can be reset here.");
  const account=await auth.getUser(uid);
  if(account.disabled||account.email!==target.data().email||!account.email?.endsWith("@floor.plantflow.invalid"))throw new HttpsError("failed-precondition","This is not an active employee-name account.");
  // Never log, return, or store the replacement secret in Firestore.
  await auth.updateUser(uid,{password:request.data.passcode});
  await auth.revokeRefreshTokens(uid);
  await targetRef.update({passcodeResetAt:FieldValue.serverTimestamp(),passcodeResetBy:request.auth.uid});
  return {ok:true};
});
