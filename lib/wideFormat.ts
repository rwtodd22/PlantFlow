import type { Job } from './dataService';

const wideFormatCreators = new Set([
  'andrew terpay', 'caroline sagebiel', 'jerome golden',
  'mckenzie bunting', 'wayne todd',
]);

export function isWideFormatJob(job: Pick<Job, 'createdByName'>): boolean {
  return wideFormatCreators.has((job.createdByName || '').trim().replace(/\s+/g, ' ').toLowerCase());
}
