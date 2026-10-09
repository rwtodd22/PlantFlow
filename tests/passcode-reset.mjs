import assert from 'node:assert/strict';
import {resetPolicy} from '../functions/resetPolicy.js';
const caller={enabled:true,role:'super_admin'};
const employee={enabled:true,role:'standard'};
const data={passcode:'Test-only-123'};
assert.equal(resetPolicy(caller,employee,data),null);
for(const role of ['admin','standard','job_creator','manager','viewer']){
 assert.equal(resetPolicy({...caller,role},employee,data),'permission-denied');
}
for(const invalid of [undefined,{...caller,enabled:false},{...caller,removed:true}]){
 assert.equal(resetPolicy(invalid,employee,data),'permission-denied');
}
for(const target of [undefined,{...employee,enabled:false},{...employee,removed:true},{...employee,role:'admin'},{...employee,role:'super_admin'}]){
 assert.equal(resetPolicy(caller,target,data),'failed-precondition');
}
for(const passcode of ['', 'short', '        ', 'a'.repeat(129),12345678]){
 assert.equal(resetPolicy(caller,employee,{passcode}),'invalid-argument');
}
console.log('PASS: Super Admin only; active employee targets only; passcode validation.');
