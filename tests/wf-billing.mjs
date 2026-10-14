import assert from 'node:assert/strict';
import {canUseWfBilling,isCompletedWfJob,isApproved} from '../functions/wfBillingPolicy.js';
const members=['Wayne Todd','McKenzie Bunting','Andrew Terpay','Caroline Sagebiel','Jerome Golden'];
for(const displayName of members){
  assert.equal(canUseWfBilling({displayName,role:'job_creator',enabled:true}),true);
  assert.equal(canUseWfBilling({displayName,role:'job_creator',enabled:false}),false);
  assert.equal(canUseWfBilling({displayName,role:'job_creator',enabled:true,removed:true}),false);
}
assert.equal(canUseWfBilling({displayName:'Someone Else',role:'super_admin',enabled:true}),false);
assert.equal(canUseWfBilling({displayName:'Wayne Todd',role:'viewer',enabled:true}),false);
assert.equal(canUseWfBilling(undefined),false);
assert.equal(canUseWfBilling({displayName:' WAYNE   TODD ',role:'job_creator',enabled:true}),true);
const statuses=[{code:'COMPLETE',name:'Complete'},{code:'CANCELED',name:'Canceled'}];
const job={createdByName:'Wayne Todd',status:'Complete'};
assert.equal(isCompletedWfJob(job,statuses),true);
assert.equal(isCompletedWfJob({...job,createdByName:'Other'},statuses),false);
assert.equal(isCompletedWfJob({...job,status:'Canceled'},statuses),false);
assert.equal(isCompletedWfJob({...job,parts:[{status:'Complete'},{status:'In Production'}]},statuses),false);
assert.equal(isCompletedWfJob({...job,parts:[{status:'Complete'},{status:'Complete'}]},statuses),true);
assert.equal(isApproved(job),false);
assert.equal(isApproved({...job,billingState:'approved'}),true);
assert.equal(isApproved({...job,billingApprovedAt:'date'}),true);
assert.equal(isApproved({...job,billingState:'hold',billingApprovedAt:'date'}),false);
console.log('PASS: exact designated accounts, disabled/removed/other roles denied, completed WF-only policy, split completion, billing approval gate.');
