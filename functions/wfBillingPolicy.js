const names = new Set(['wayne todd','mckenzie bunting','andrew terpay','caroline sagebiel','jerome golden']);
const normalize = name => typeof name === 'string' ? name.trim().replace(/\s+/g,' ').toLowerCase() : '';
export function canUseWfBilling(profile) {
  return Boolean(profile?.enabled && !profile.removed && ['super_admin','admin','job_creator','standard'].includes(profile.role) && names.has(normalize(profile.displayName)));
}
export function isCompletedWfJob(job, statuses) {
  const complete = new Set(statuses.filter(status=>status.code==='COMPLETE').map(status=>status.name));
  return names.has(normalize(job?.createdByName)) && (job.parts?.length ? job.parts.every(part=>complete.has(part.status)) : complete.has(job.status));
}
export function isApproved(job) {
  return job.billingState === 'approved' || (job.billingState === undefined && Boolean(job.billingApprovedAt));
}
