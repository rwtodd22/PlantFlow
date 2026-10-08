import {readFileSync} from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
const source=ts.transpileModule(readFileSync('lib/intakeJobs.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {includeCreatedJob}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const job={id:'new-job',jobNumber:'123456',status:'Ready'};
const other={id:'other-job',jobNumber:'234567'};
// Write callback first, followed by the authoritative live list.
let jobs=includeCreatedJob([other],job);
assert.deepEqual(jobs,[job,other]);
jobs=[job,other];
assert.equal(jobs.filter(item=>item.id===job.id).length,1);
// Live snapshot first, followed by write completion; retain newer live edits.
const live=[{...job,status:'In Production'},other];
assert.equal(includeCreatedJob(live,job),live);
assert.equal(includeCreatedJob(includeCreatedJob(live,job),job).length,2);
// Identity is the stable ID, not a potentially reused job number.
assert.equal(includeCreatedJob([{...job,id:'different-record'}],job).length,2);
console.log('PASS: both event orders, repeated completion, latest live data retained, stable-ID matching.');
