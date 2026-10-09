import {initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {getFirestore,FieldValue} from "firebase-admin/firestore";
import {onCall,HttpsError} from "firebase-functions/v2/https";
import {resetPolicy} from "./resetPolicy.js";
initializeApp();

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
