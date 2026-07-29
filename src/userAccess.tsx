import { FormEvent, useEffect, useMemo, useState } from "react";
import { deleteApp, initializeApp } from "firebase/app";
import { createUserWithEmailAndPassword, getAuth, sendPasswordResetEmail, signOut } from "firebase/auth";
import { collection, doc, onSnapshot, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { auth, db, firebaseConfig } from "./firebase";

type AccessUser = {
  uid: string;
  email: string;
  displayName: string;
  role: AccessRole;
  enabled: boolean;
  removed?: boolean;
  createdAt?: unknown;
  lastSignInAt?: unknown;
};

type AccessRole = "super_admin"|"admin"|"standard";
const ownerUid="TOXwE0xXDlgoL4YqBbrTOGjxCyk1";
const roleLabels:Record<AccessRole,string>={super_admin:"Super Admin",admin:"Admin",standard:"Standard"};

type Feedback = {kind:"success"|"error";message:string}|null;

function dateValue(value: unknown) {
  if (!value) return "Not signed in yet";
  const candidate = value as {toDate?:()=>Date;seconds?:number};
  const date = typeof candidate.toDate === "function" ? candidate.toDate() : candidate.seconds ? new Date(candidate.seconds*1000) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "Not signed in yet" : date.toLocaleString([], {month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"});
}

function userError(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code.includes("email-already-in-use")) return "An account already exists for that email address.";
  if (code.includes("invalid-email")) return "Enter a valid email address.";
  if (code.includes("weak-password")) return "Use a password with at least 8 characters.";
  if (code.includes("too-many-requests")) return "Firebase is temporarily limiting requests. Wait a moment and try again.";
  return error instanceof Error ? error.message : "PlantFlow could not complete that account change.";
}

export function UserAccessPanel({currentUid}:{currentUid:string}) {
  const [users,setUsers]=useState<AccessUser[]>([]);
  const [loading,setLoading]=useState(true);
  const [mode,setMode]=useState<"invite"|"password">("invite");
  const [busy,setBusy]=useState(false);
  const [feedback,setFeedback]=useState<Feedback>(null);

  useEffect(()=>onSnapshot(collection(db,"users"),snapshot=>{
    setUsers(snapshot.docs.map(item=>({uid:item.id,...item.data()} as AccessUser)).sort((a,b)=>(a.removed===b.removed?0:a.removed?1:-1)||a.displayName.localeCompare(b.displayName)));
    setLoading(false);
  },error=>{
    setFeedback({kind:"error",message:error.message||"User access could not be loaded."});
    setLoading(false);
  }),[]);

  const activeCount=useMemo(()=>users.filter(item=>item.enabled&&!item.removed).length,[users]);

  const createUser=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();
    const form=event.currentTarget;
    const values=new FormData(form);
    const displayName=String(values.get("displayName")||"").trim();
    const email=String(values.get("email")||"").trim().toLowerCase();
    const suppliedPassword=String(values.get("password")||"");
    const role=String(values.get("role")||"standard") as AccessRole;
    const password=mode==="invite"?`${crypto.randomUUID()}Aa1!`:suppliedPassword;
    if(!displayName||!email){setFeedback({kind:"error",message:"Enter the person’s name and email address."});return;}
    if(mode==="password"&&password.length<8){setFeedback({kind:"error",message:"Use a temporary password with at least 8 characters."});return;}
    setBusy(true);setFeedback(null);
    const secondaryApp=initializeApp(firebaseConfig,`plantflow-create-user-${Date.now()}`);
    const secondaryAuth=getAuth(secondaryApp);
    try{
      const credential=await createUserWithEmailAndPassword(secondaryAuth,email,password);
      await setDoc(doc(db,"users",credential.user.uid),{email,displayName,role,enabled:true,removed:false,createdAt:serverTimestamp(),createdBy:currentUid,lastSignInAt:null});
      await signOut(secondaryAuth);
      if(mode==="invite") await sendPasswordResetEmail(auth,email);
      form.reset();
      setFeedback({kind:"success",message:mode==="invite"?`Invitation sent to ${email}. They can use the email link to choose a password.`:`${displayName} can now sign in with the password you assigned.`});
    }catch(error){setFeedback({kind:"error",message:userError(error)});}finally{
      await signOut(secondaryAuth).catch(()=>undefined);
      await deleteApp(secondaryApp).catch(()=>undefined);
      setBusy(false);
    }
  };

  const changeAccess=async(item:AccessUser,action:"enable"|"disable"|"remove")=>{
    if(item.uid===currentUid&&action!=="enable"){setFeedback({kind:"error",message:"You cannot disable or remove the account you are currently using."});return;}
    setFeedback(null);
    try{
      await updateDoc(doc(db,"users",item.uid),action==="enable"?{enabled:true,removed:false,restoredAt:serverTimestamp()}:{enabled:false,removed:action==="remove",[action==="remove"?"removedAt":"disabledAt"]:serverTimestamp()});
      setFeedback({kind:"success",message:action==="enable"?`${item.displayName} has full PlantFlow access again.`:action==="remove"?`${item.displayName} was removed from PlantFlow access. Production history was not changed.`:`${item.displayName} is temporarily disabled.`});
    }catch(error){setFeedback({kind:"error",message:userError(error)});}
  };

  const resetPassword=async(item:AccessUser)=>{
    try{await sendPasswordResetEmail(auth,item.email);setFeedback({kind:"success",message:`Password setup email sent to ${item.email}.`});}
    catch(error){setFeedback({kind:"error",message:userError(error)});}
  };

  const changeRole=async(item:AccessUser,role:AccessRole)=>{
    if(item.uid===ownerUid){setFeedback({kind:"error",message:"The primary PlantFlow owner always remains a Super Admin."});return;}
    try{await updateDoc(doc(db,"users",item.uid),{role,roleChangedAt:serverTimestamp(),roleChangedBy:currentUid});setFeedback({kind:"success",message:`${item.displayName} is now ${roleLabels[role]}.`});}
    catch(error){setFeedback({kind:"error",message:userError(error)});}
  };

  return <section className="panel user-access-panel">
    <div className="user-access-heading"><div><p className="eyebrow">SECURE USER MANAGEMENT</p><h2>User access</h2><p>Create and manage Super Admin, Admin, and Standard accounts. Only Super Admins can see or change this area.</p></div><span className="user-count"><b>{activeCount}</b> active {activeCount===1?"user":"users"}</span></div>
    <div className="user-access-layout">
      <form className="user-invite-card" onSubmit={createUser}>
        <div className="access-mode-tabs"><button type="button" className={mode==="invite"?"active":""} onClick={()=>setMode("invite")}>Invite by email</button><button type="button" className={mode==="password"?"active":""} onClick={()=>setMode("password")}>Assign password</button></div>
        <label><span>Name</span><input name="displayName" required placeholder="Employee name"/></label>
        <label><span>Email address</span><input name="email" type="email" required placeholder="name@worthhiggins.com"/></label>
        <label><span>Access level</span><select name="role" defaultValue="standard"><option value="super_admin">Super Admin — complete access</option><option value="admin">Admin — everything except user access</option><option value="standard">Standard — production access</option></select></label>
        {mode==="password"&&<label><span>Temporary password</span><input name="password" type="password" required minLength={8} autoComplete="new-password" placeholder="At least 8 characters"/><small>Share this privately. The user can request a password-reset email later.</small></label>}
        {mode==="invite"&&<p className="invite-explainer">Firebase will email a secure link so the user can choose their own password. PlantFlow never displays or emails a readable password.</p>}
        <button className="primary" disabled={busy}>{busy?"Creating account…":mode==="invite"?"Create account & send invite":"Create account"}</button>
      </form>
      <div className="user-directory">
        <div className="user-directory-head"><div><h3>PlantFlow users</h3><p>Disable access temporarily or remove it without changing production history.</p></div></div>
        {feedback&&<div className={`user-feedback ${feedback.kind}`} role="status">{feedback.message}<button type="button" aria-label="Dismiss message" onClick={()=>setFeedback(null)}>×</button></div>}
        {loading?<div className="user-empty">Loading users…</div>:users.length===0?<div className="user-empty">No PlantFlow users have been added.</div>:<div className="user-list">{users.map(item=><article className={`user-row ${item.removed?"removed":""}`} key={item.uid}>
          <div className="user-avatar" aria-hidden="true">{(item.displayName||item.email).slice(0,1).toUpperCase()}</div>
          <div className="user-identity"><div><b>{item.displayName||"PlantFlow user"}</b>{item.uid===currentUid&&<em>You</em>}<span className={`role-state ${item.uid===ownerUid?"super_admin":item.role}`}>{roleLabels[item.uid===ownerUid?"super_admin":item.role]||"Standard"}</span>{item.removed?<span className="access-state removed">Removed</span>:item.enabled?<span className="access-state active">Active</span>:<span className="access-state disabled">Disabled</span>}</div><small>{item.email}</small><small>Last sign-in: {dateValue(item.lastSignInAt)}</small></div>
          <div className="user-actions">{item.uid===ownerUid?<span className="locked-role-control" title="The primary owner always remains a Super Admin">Super Admin</span>:<select aria-label={`Access level for ${item.displayName}`} value={item.role} disabled={item.removed} onChange={event=>changeRole(item,event.target.value as AccessRole)}><option value="super_admin">Super Admin</option><option value="admin">Admin</option><option value="standard">Standard</option></select>}<button type="button" onClick={()=>resetPassword(item)}>Send password link</button>{item.enabled&&!item.removed?<button type="button" disabled={item.uid===currentUid} onClick={()=>changeAccess(item,"disable")}>Disable</button>:<button type="button" onClick={()=>changeAccess(item,"enable")}>{item.removed?"Restore access":"Enable"}</button>}<button type="button" className="remove-user" disabled={item.uid===currentUid||item.removed} onClick={()=>changeAccess(item,"remove")}>Remove access</button></div>
        </article>)}</div>}
      </div>
    </div>
  </section>;
}
