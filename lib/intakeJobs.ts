import type {Job} from './dataService';

export function includeCreatedJob(jobs: Job[], created: Job): Job[] {
  // The live snapshot can arrive before the write promise resolves. Preserve
  // that copy (which may already contain newer edits) rather than adding twice.
  return jobs.some(job=>job.id===created.id) ? jobs : [created,...jobs];
}
