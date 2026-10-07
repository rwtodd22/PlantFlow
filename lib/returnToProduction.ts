import type {Department, Job, ScanEvent, StatusDefinition} from './dataService';

export type ProductionReturn = {partId?: string; departmentId: string; status: string};

export function prepareProductionReturn(job: Job, changes: ProductionReturn[], departments: Department[], statuses: StatusDefinition[], now: string, eventIds: string[]) {
  const parts = job.parts || [];
  const complete = (name: string) => statuses.some(status => status.name === name && status.code === 'COMPLETE');
  if (!(parts.length ? parts.every(part => complete(part.status)) : complete(job.status))) throw new Error('This job is no longer in Ready for Billing. Refresh and review its current status.');
  if (!changes.length || eventIds.length !== changes.length) throw new Error('Choose at least one job or part to return.');
  // Each event checks barcode locks. Bound the atomic write to the rules access budget.
  if (changes.length > 5) throw new Error('Return up to five parts together. After reopening, additional parts can be changed in Active Jobs.');
  if (new Set(changes.map(change => change.partId)).size !== changes.length) throw new Error('Each part can only be selected once.');
  const events: ScanEvent[] = changes.map((change, index) => {
    const part = parts.find(part => part.id === change.partId);
    if (parts.length ? !part : changes.length !== 1 || change.partId !== undefined) throw new Error('The job parts have changed. Close this window and try again.');
    const status = statuses.find(status => status.name === change.status && status.enabled && !status.closesJob);
    const department = departments.find(department => department.id === change.departmentId && department.enabled);
    if (!status || (change.departmentId && !department)) throw new Error('Choose an available department and an active production status.');
    return {id:eventIds[index],jobId:job.id,jobNumber:part?.code || job.jobNumber,departmentId:change.departmentId,departmentName:department?.name || 'Not started',previousDepartmentId:part?.currentDepartmentId ?? job.currentDepartmentId,timestamp:now,timestampBasis:'recorded',type:'Manual',statusName:status.name,statusClosesJob:false,...(part?{partId:part.id,partCode:part.code,partName:part.name}:{})};
  });
  const {completedAt, billingState, billingApprovedAt, billingClearedAt, ...retained} = job;
  const next: Job = {...retained,updatedAt:now};
  if (parts.length) next.parts = parts.map(part => {const change=changes.find(change=>change.partId===part.id);return change?{...part,currentDepartmentId:change.departmentId,status:change.status,updatedAt:now}:part;});
  else {next.currentDepartmentId=changes[0].departmentId;next.status=changes[0].status;}
  return {job:next,events};
}
