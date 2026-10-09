export function resetPolicy(caller, target, data) {
  if(!caller?.enabled||caller.removed||caller.role!=="super_admin")return "permission-denied";
  if(!target?.enabled||target.removed||target.role!=="standard")return "failed-precondition";
  if(typeof data?.passcode!=="string"||data.passcode.length<8||data.passcode.length>128||!data.passcode.trim())return "invalid-argument";
  return null;
}
