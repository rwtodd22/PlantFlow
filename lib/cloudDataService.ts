import { cleanPersonName, jobPeopleNames, rememberJobPeople, emptyPeopleNames, type PeopleNames } from "./jobPeople";
import {scanTransition} from "./scanTransition";
import { DocumentReference, DocumentSnapshot, Unsubscribe, arrayUnion, runTransaction, collection, doc, getDoc, getDocs, getDocsFromServer, documentId, limit, onSnapshot, orderBy, query, serverTimestamp, startAfter, where, writeBatch } from "firebase/firestore";
import { db } from "../src/firebase";
import { AppState, Job, ScanEvent, seedState } from "./dataService";
import {prepareProductionReturn, type ProductionReturn} from './returnToProduction';

const configurationDocument = doc(db, "configuration", "plantflow");
const peopleDocument = doc(db, "configuration", "jobPeople");
const jobsCollection = collection(db, "jobs");
const scansCollection = collection(db, "scanEvents");
const publicConfigurationDocument = doc(db, "publicConfiguration", "plantflow");
const publicJobsCollection = collection(db, "publicJobs");
const LIVE_SCAN_LIMIT = 300;
const HISTORY_PAGE_SIZE = 250;

type Configuration = Pick<AppState, "departments" | "statuses" | "settings">;

async function deleteDocumentsInBatches(documents: Array<{ ref: DocumentReference }>) {
  for (let index = 0; index < documents.length; index += 450) {
    const batch = writeBatch(db);
    documents.slice(index, index + 450).forEach(item => batch.delete(item.ref));
    await batch.commit();
  }
}

/**
 * Firestore rejects `undefined` anywhere in a document. Optional application
 * fields (job parts and scan metadata) are represented as `undefined` in
 * memory, so remove only those values at the cloud boundary while preserving
 * valid empty strings, false values, arrays, and timestamps.
 */
function firestoreDocument<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter(item => item !== undefined)
      .map(item => firestoreDocument(item)) as T;
  }
  if (
    value
    && typeof value === "object"
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, firestoreDocument(item)]),
    ) as T;
  }
  return value;
}

function configurationOf(state: AppState): Configuration {
  return { departments: state.departments, statuses: state.statuses, settings: state.settings };
}

function changed(left: unknown, right: unknown) {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function publicJob(job: Job): Job {
  return firestoreDocument({
    ...job,
    notes: "",
    savedCustomerRepresentatives: undefined,
    savedProjectManagers: undefined,
    billingState: undefined,
    billingNote: undefined,
    billingApprovedAt: undefined,
    billingClearedAt: undefined,
  });
}

function isClosed(job: Job, state: AppState) {
  const parts = job.parts || [];
  if (parts.length) return parts.every(part => state.statuses.find(status => status.name === part.status)?.closesJob);
  return Boolean(state.statuses.find(status => status.name === job.status)?.closesJob);
}

async function readJobEventDocuments(job: Job) {
  const codes = [...new Set([job.jobNumber, ...(job.parts || []).map(part => part.code)])];
  const filters = [where("jobId", "==", job.id)];
  for (let index = 0; index < codes.length; index += 30) filters.push(where("jobNumber", "in", codes.slice(index, index + 30)));
  const found = new Map<string, import("firebase/firestore").QueryDocumentSnapshot>();
  for (const filter of filters) {
    let cursor: DocumentSnapshot | undefined;
    while (true) {
      const page = await getDocsFromServer(query(scansCollection, filter, orderBy(documentId()), ...(cursor ? [startAfter(cursor)] : []), limit(200)));
      page.docs.forEach(event => { const data = event.data(); if (!data.jobId || data.jobId === job.id) found.set(event.id, event); });
      if (page.size < 200) break;
      cursor = page.docs.at(-1);
    }
  }
  return [...found.values()];
}

function peopleUpdates(jobs: Job[]) {
  const representatives = jobPeopleNames(jobs).customerRepresentatives;
  const managers = jobPeopleNames(jobs).projectManagers;
  return { ...(representatives.length ? {customerRepresentatives: arrayUnion(...representatives)} : {}), ...(managers.length ? {projectManagers: arrayUnion(...managers)} : {}) };
}

export const cloudDataService = {
  async commitScan(jobId:string, code:string, prefix:string, statusId?:string, receipt?:{id:string;scannedAt:string}) {
    const eventRef=receipt?doc(scansCollection,receipt.id):doc(scansCollection);
    return runTransaction(db,async transaction=>{
      const jobRef=doc(jobsCollection,jobId);
      const [source,configuration,existing]=await Promise.all([transaction.get(jobRef),transaction.get(configurationDocument),transaction.get(eventRef)]);
      if(existing.exists())return {job:source.data() as Job,event:existing.data() as ScanEvent};
      if(!source.exists()||!configuration.exists())throw new Error("Job or configuration is unavailable. Refresh and try again.");
      const config=configuration.data() as Configuration;
      const latest=source.data() as Job;
      const tracked=latest.parts?.find(p=>p.code.toUpperCase()===code)||latest;
      if(receipt&&Date.parse(tracked.updatedAt)>Date.parse(receipt.scannedAt))throw new Error("A newer update exists for this job or part. Review this offline scan before applying it.");
      const result=scanTransition(latest,config.departments,config.statuses,code,prefix,statusId,receipt?.scannedAt||new Date().toISOString(),eventRef.id);
      if(!result)return null;
      transaction.set(jobRef,firestoreDocument(result.job));
      if(isClosed(result.job,config as AppState))transaction.delete(doc(publicJobsCollection,jobId));
      else transaction.set(doc(publicJobsCollection,jobId),publicJob(result.job));
      transaction.set(eventRef,firestoreDocument(result.event));
      return result;
    });
  },
  async savePerson(field: "customerRepresentative" | "projectManager", name: string) {
    const cleaned = cleanPersonName(name);
    if (!cleaned) return;
    const key = field === "customerRepresentative" ? "customerRepresentatives" : "projectManagers";
    const removedKey = field === "customerRepresentative" ? "removedCustomerRepresentatives" : "removedProjectManagers";
    // Transaction preserves concurrent additions and only restores an explicitly added name.
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(peopleDocument);
      const removed = (snapshot.data()?.[removedKey] || []) as string[];
      transaction.set(peopleDocument, {
        [key]: arrayUnion(cleaned),
        [removedKey]: removed.filter(item => cleanPersonName(item).toLocaleLowerCase() !== cleaned.toLocaleLowerCase()),
      }, {merge:true});
    });
  },
  async removeSavedPerson(field: "customerRepresentative" | "projectManager", name: string) {
    const cleaned=cleanPersonName(name);
    if(!cleaned)return;
    // Keep a suppression marker so old jobs cannot repopulate a removed suggestion.
    // Existing configuration rules restrict this shared-list change to admins.
    const batch=writeBatch(db);
    batch.set(peopleDocument,{[field==='customerRepresentative'?'removedCustomerRepresentatives':'removedProjectManagers']:arrayUnion(cleaned)},{merge:true});
    await batch.commit();
  },
  async returnToProduction(jobId: string, changes: ProductionReturn[], uid: string) {
    const eventIds = changes.map(() => doc(scansCollection).id);
    return runTransaction(db, async transaction => {
      const [profile, source, archive, deletion, config] = await Promise.all([
        transaction.get(doc(db,'users',uid)), transaction.get(doc(jobsCollection,jobId)),
        transaction.get(doc(db,'archivedJobs',jobId)), transaction.get(doc(db,'jobDeletions',jobId)), transaction.get(configurationDocument),
      ]);
      if (!profile.data()?.enabled || !['admin','super_admin'].includes(profile.data()?.role)) throw new Error('Administrator access is required.');
      if (archive.exists()) throw new Error('Archived billing records cannot be reopened.');
      if (deletion.exists()) throw new Error('This job is being deleted and cannot be reopened.');
      if (!source.exists() || !config.exists()) throw new Error('This job is no longer available. Refresh the page.');
      const configuration = config.data() as Configuration;
      const result = prepareProductionReturn(source.data() as Job,changes,configuration.departments,configuration.statuses,new Date().toISOString(),eventIds);
      transaction.set(doc(jobsCollection,jobId),firestoreDocument(result.job));
      transaction.set(doc(publicJobsCollection,jobId),publicJob(result.job));
      result.events.forEach(event=>transaction.set(doc(scansCollection,event.id),firestoreDocument(event)));
      return result;
    });
  },
  subscribeJobPeople(onNames: (names: PeopleNames) => void, onError: (error: Error) => void): Unsubscribe {
    return onSnapshot(peopleDocument, snapshot => onNames({...emptyPeopleNames, ...(snapshot.exists() ? snapshot.data() : {})} as PeopleNames), onError);
  },
  async archiveJob(jobId: string, uid: string) {
    const archiveRef = doc(db, "archivedJobs", jobId);
    await runTransaction(db, async transaction => {
      const jobRef = doc(jobsCollection, jobId);
      const [jobSnapshot, archiveSnapshot, configSnapshot] = await Promise.all([
        transaction.get(jobRef), transaction.get(archiveRef), transaction.get(configurationDocument),
      ]);
      if (archiveSnapshot.exists() && !jobSnapshot.exists()) return;
      if (!jobSnapshot.exists() || archiveSnapshot.exists()) throw new Error("This job changed. Refresh Billing before archiving.");
      const job = jobSnapshot.data() as Job;
      const config = configSnapshot.data() as Configuration;
      const complete = (status: string) => config.statuses.some(item => item.name === status && item.code === "COMPLETE");
      if (!(job.parts?.length ? job.parts.every(part => complete(part.status)) : complete(job.status))) throw new Error("Only completed jobs can be archived.");
      if (job.billingState !== "approved" && !(job.billingState === undefined && job.billingApprovedAt)) throw new Error("Mark the job OK to bill before archiving.");
      const historyCodes = [...new Set([job.jobNumber, ...(job.parts || []).map(part => part.code)])];
      if (historyCodes.some(code => !code || code.includes("/") || code === "." || code === "..")) throw new Error("This legacy barcode cannot be safely locked for archival. The job has not been moved.");
      const locks = historyCodes.map(code => doc(db, "archiveHistoryLocks", code));
      const lockSnapshots = await Promise.all(locks.map(ref => transaction.get(ref)));
      if (lockSnapshots.some(snapshot => snapshot.exists())) throw new Error("History for a matching barcode is already being captured. Finish that archive first.");
      const names = peopleUpdates([job]);
      if (Object.keys(names).length) transaction.set(peopleDocument, names, {merge:true});
      transaction.set(archiveRef, { job, departments: config.departments, statuses: config.statuses, archivedAt: serverTimestamp(), archivedBy: uid, historyStatus: "capturing", historyCodes });
      locks.forEach(ref => transaction.set(ref, { archiveId: jobId }));
      transaction.delete(jobRef);
      transaction.delete(doc(publicJobsCollection, jobId));
    });
    await this.finishArchiveHistory(jobId);
  },

  async finishArchiveHistory(jobId: string) {
    const archiveRef = doc(db, "archivedJobs", jobId);
    const snapshot = await getDoc(archiveRef);
    if (!snapshot.exists()) throw new Error("Archived job not found.");
    const archive = snapshot.data();
    if (archive.historyStatus === "complete") return;
    if (archive.historyStatus !== "capturing") throw new Error("This older archive has no history capture. No history was invented.");
    // Source events are frozen by the archive ID and temporary barcode locks.
    // Deterministic document IDs make interrupted batches safe to retry.
    const events = await readJobEventDocuments(archive.job as Job);
    for (let index = 0; index < events.length; index += 15) {
      const batch = writeBatch(db);
      events.slice(index, index + 15).forEach(event => batch.set(doc(archiveRef, "events", event.id), event.data()));
      await batch.commit();
    }
    await runTransaction(db, async transaction => {
      const current = await transaction.get(archiveRef);
      if (current.data()?.historyStatus === "complete") return;
      transaction.update(archiveRef, { historyStatus: "complete", historyEventCount: events.length, historyCapturedAt: serverTimestamp() });
      (archive.historyCodes as string[]).forEach(code => transaction.delete(doc(db, "archiveHistoryLocks", code)));
    });
  },

  async loadJobHistory(job: Job) {
    return (await readJobEventDocuments(job)).map(event => ({ ...event.data(), id: event.id } as ScanEvent));
  },

  async loadArchiveHistory(jobId: string) {
    const result: ScanEvent[] = [];
    let cursor: DocumentSnapshot | undefined;
    while (true) {
      const page = await getDocsFromServer(query(collection(db, "archivedJobs", jobId, "events"), orderBy(documentId()), ...(cursor ? [startAfter(cursor)] : []), limit(200)));
      result.push(...page.docs.map(event => ({ ...event.data(), id: event.id } as ScanEvent)));
      if (page.size < 200) return result;
      cursor = page.docs.at(-1);
    }
  },

  async loadArchivedJobs(sort: import("./archiveTypes").ArchiveSort, cursor?: DocumentSnapshot) {
    const fields = { newest: ["archivedAt", "desc"], oldest: ["archivedAt", "asc"], job: ["job.jobNumber", "asc"], customer: ["job.customer", "asc"] } as const;
    const [field, direction] = fields[sort];
    const snapshot = await getDocs(query(collection(db, "archivedJobs"), orderBy(field, direction), ...(cursor ? [startAfter(cursor)] : []), limit(25)));
    return { records: snapshot.docs.map(item => ({ id: item.id, ...item.data() } as import("./archiveTypes").ArchivedJob)), cursor: snapshot.docs.at(-1), hasMore: snapshot.size === 25 };
  },
  subscribeJobIntake(onState: (state: AppState | null) => void, onError: (error: Error) => void): Unsubscribe {
    let configuration: Configuration | null = null;
    let jobs: Job[] = [];
    let configurationLoaded = false;
    let jobsLoaded = false;
    const emit = () => {
      if (!configurationLoaded || !jobsLoaded) return;
      onState(configuration ? {
        ...seedState,
        ...configuration,
        settings: { ...seedState.settings, ...configuration.settings },
        jobs,
        scans: [],
      } : null);
    };
    const unsubscribers = [
      onSnapshot(configurationDocument, snapshot => {
        configurationLoaded = true;
        configuration = snapshot.exists() ? snapshot.data() as Configuration : null;
        emit();
      }, onError),
      onSnapshot(jobsCollection, snapshot => {
        jobsLoaded = true;
        jobs = snapshot.docs.map(item => item.data() as Job);
        emit();
      }, onError),
    ];
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
  },

  async createJobFromIntake(job: Job, rememberSharedNames = false) {
    job = rememberJobPeople(job);
    const batch = writeBatch(db);
    batch.set(doc(jobsCollection, job.id), firestoreDocument(job));
    batch.set(doc(publicJobsCollection, job.id), publicJob(job));
    const names = peopleUpdates([job]);
    if (rememberSharedNames && Object.keys(names).length) batch.set(peopleDocument, names, {merge:true});
    await batch.commit();
  },

  async deleteJobPermanently(job: Job, uid: string, confirmation: string) {
    if (!uid || confirmation.trim() !== `DELETE ${job.jobNumber}`) throw new Error("Type the exact deletion phrase to continue.");
    const jobRef = doc(jobsCollection, job.id);
    const receiptRef = doc(db, "jobDeletions", job.id);
    // Keep the job/number reserved until history cleanup succeeds. The receipt
    // freezes edits and permits an interrupted operation to be safely retried.
    const pending = await runTransaction(db, async transaction => {
      const [source, receipt, archive] = await Promise.all([
        transaction.get(jobRef), transaction.get(receiptRef), transaction.get(doc(db, "archivedJobs", job.id)),
      ]);
      if (archive.exists()) throw new Error("Billing archives cannot be permanently deleted.");
      if (receipt.exists()) {
        if (receipt.data().jobNumber !== job.jobNumber) throw new Error("The job number has changed. Reopen the job before deleting.");
        return receipt.data().state === "complete" ? null : receipt.data().job as Job;
      }
      if (!source.exists()) throw new Error("This job no longer exists. Refresh the job list.");
      const current = source.data() as Job;
      if (current.jobNumber !== job.jobNumber) throw new Error("The job number has changed. Reopen the job before deleting.");
      if (current.billingState === "approved" || (!("billingState" in current) && current.billingApprovedAt)) throw new Error("This job is OK to bill. Remove billing approval before deleting a mistaken job.");
      const codes = [...new Set([current.jobNumber, ...(current.parts || []).map(part => part.code)])];
      if (codes.some(code => !code || code.includes("/"))) throw new Error("This job contains an invalid barcode. Correct it before deleting.");
      const locks = await Promise.all(codes.map(code => transaction.get(doc(db, "deletionHistoryLocks", code))));
      if (locks.some(lock => lock.exists())) throw new Error("Another deletion is using this barcode. Finish that deletion first.");
      transaction.set(receiptRef, { job: current, jobNumber: current.jobNumber, codes, state: "pending", requestedBy: uid, requestedAt: serverTimestamp(), confirmation: confirmation.trim() });
      return current;
    });
    if (!pending) return;
    const codes = [...new Set([pending.jobNumber, ...(pending.parts || []).map(part => part.code)])];
    // Acquire barcode locks in small transactions so 26-part jobs stay within
    // Firestore's per-request rules access budget. Retry existing owned locks.
    for (let index = 0; index < codes.length; index += 10) {
      await runTransaction(db, async transaction => {
        const refs = codes.slice(index, index + 10).map(code => doc(db, "deletionHistoryLocks", code));
        const locks = await Promise.all(refs.map(ref => transaction.get(ref)));
        locks.forEach((lock, offset) => {
          if (lock.exists() && lock.data().jobId !== job.id) throw new Error("Another deletion is using this barcode. Finish that deletion first.");
          if (!lock.exists()) transaction.set(refs[offset], {jobId: job.id});
        });
      });
    }
    // Small batches stay within rules document-access limits even for old,
    // renamed barcodes. No arbitrary 300-event history cutoff.
    const events = await readJobEventDocuments(pending);
    for (let index = 0; index < events.length; index += 10) {
      await deleteDocumentsInBatches(events.slice(index, index + 10));
    }
    await runTransaction(db, async transaction => {
      const receipt = await transaction.get(receiptRef);
      if (receipt.data()?.state === "complete") return;
      if (receipt.data()?.state !== "pending") throw new Error("Deletion authorization is missing. Please retry.");
      const {job: _snapshot, ...audit} = receipt.data()!;
      transaction.set(receiptRef, {...audit, state: "complete", completedAt: serverTimestamp(), completedBy: uid});
      transaction.delete(jobRef);
      transaction.delete(doc(publicJobsCollection, job.id));
      (audit.codes as string[]).forEach(code => transaction.delete(doc(db, "deletionHistoryLocks", code)));
    });
  },

  async deletePartHistory(partCode: string) {
    const scanSnapshot = await getDocs(query(scansCollection, where("jobNumber", "==", partCode)));
    await deleteDocumentsInBatches(scanSnapshot.docs);
  },

  async clearAllJobData(uid: string, confirmation: string) {
    if (!uid || confirmation.trim() !== "DELETE ALL JOBS") throw new Error("Type DELETE ALL JOBS to continue.");
    const snapshot = await getDocs(jobsCollection);
    const jobs = snapshot.docs.map(item => ({...item.data(), id: item.id}) as Job);
    if (jobs.some(job => job.billingState === "approved" || (!("billingState" in job) && job.billingApprovedAt))) {
      throw new Error("No jobs were deleted. Some jobs are OK to bill. Archive them or remove their billing approval before resetting jobs. Billing archives will be kept.");
    }
    let deleted = 0;
    for (const job of jobs) {
      try {
        await this.deleteJobPermanently(job, uid, `DELETE ${job.jobNumber}`);
        deleted++;
      } catch (error) {
        throw new Error(`${deleted} of ${jobs.length} jobs deleted. Reset stopped at job ${job.jobNumber}. ${error instanceof Error ? error.message : "Check your connection and administrator access."} You can retry to finish remaining jobs.`);
      }
    }
    return {deleted, jobs};
  },

  subscribe(onState: (state: AppState | null) => void, onError: (error: Error) => void): Unsubscribe {
    let configuration: Configuration | null = null;
    let jobs: Job[] = [];
    let scans: ScanEvent[] = [];
    let configurationLoaded = false;
    let jobsLoaded = false;
    let scansLoaded = false;

    const emit = () => {
      if (!configurationLoaded || !jobsLoaded || !scansLoaded) return;
      if (!configuration) {
        onState(null);
        return;
      }
      onState({
        ...seedState,
        ...configuration,
        settings: { ...seedState.settings, ...configuration.settings },
        jobs,
        scans: [...scans].sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
      });
    };

    const unsubscribers = [
      onSnapshot(configurationDocument, snapshot => {
        configurationLoaded = true;
        configuration = snapshot.exists() ? snapshot.data() as Configuration : null;
        emit();
      }, onError),
      onSnapshot(jobsCollection, snapshot => {
        jobsLoaded = true;
        jobs = snapshot.docs.map(item => item.data() as Job);
        emit();
      }, onError),
      onSnapshot(query(scansCollection, orderBy("timestamp", "desc"), limit(LIVE_SCAN_LIMIT)), snapshot => {
        scansLoaded = true;
        scans = snapshot.docs.map(item => item.data() as ScanEvent);
        emit();
      }, onError),
    ];
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
  },

  async loadOlderScans(beforeTimestamp: string, pageSize = HISTORY_PAGE_SIZE) {
    const snapshot = await getDocs(query(
      scansCollection,
      orderBy("timestamp", "desc"),
      startAfter(beforeTimestamp),
      limit(pageSize),
    ));
    return {
      scans: snapshot.docs.map(item => item.data() as ScanEvent),
      hasMore: snapshot.size === pageSize,
    };
  },

  subscribePublic(onState: (state: AppState | null) => void, onError: (error: Error) => void): Unsubscribe {
    let configuration: Configuration | null = null;
    let jobs: Job[] = [];
    let configurationLoaded = false;
    let jobsLoaded = false;
    const emit = () => {
      if (!configurationLoaded || !jobsLoaded) return;
      onState(configuration ? {
        ...seedState,
        ...configuration,
        settings: { ...seedState.settings, ...configuration.settings },
        jobs,
        scans: [],
      } : null);
    };
    const unsubscribers = [
      onSnapshot(publicConfigurationDocument, snapshot => {
        configurationLoaded = true;
        configuration = snapshot.exists() ? snapshot.data() as Configuration : null;
        emit();
      }, onError),
      onSnapshot(publicJobsCollection, snapshot => {
        jobsLoaded = true;
        jobs = snapshot.docs.map(item => item.data() as Job);
        emit();
      }, onError),
    ];
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
  },

  async saveInitial(state: AppState, uid: string) {
    const writes = 2 + state.jobs.length * 2 + state.scans.length;
    if (writes > 490) throw new Error("This browser contains too many historical records for the one-step migration. Download an Excel backup before continuing.");
    const batch = writeBatch(db);
    batch.set(configurationDocument, firestoreDocument({ ...configurationOf(state), updatedAt: serverTimestamp(), updatedBy: uid }));
    batch.set(publicConfigurationDocument, firestoreDocument({ ...configurationOf(state), updatedAt: serverTimestamp() }));
    state.jobs.forEach(job => batch.set(doc(jobsCollection, job.id), firestoreDocument(job)));
    state.jobs.filter(job => !isClosed(job, state)).forEach(job => batch.set(doc(publicJobsCollection, job.id), publicJob(job)));
    state.scans.forEach(scan => batch.set(doc(scansCollection, scan.id), firestoreDocument(scan)));
    await batch.commit();
  },

  async ensurePublicState(state: AppState) {
    if ((await getDoc(publicConfigurationDocument)).exists()) return;
    const activeJobs = state.jobs.filter(job => !isClosed(job, state));
    if (1 + activeJobs.length > 490) throw new Error("The public viewer contains too many jobs for its initial one-step publication.");
    const batch = writeBatch(db);
    batch.set(publicConfigurationDocument, firestoreDocument({ ...configurationOf(state), updatedAt: serverTimestamp() }));
    activeJobs.forEach(job => batch.set(doc(publicJobsCollection, job.id), publicJob(job)));
    await batch.commit();
  },

  async saveChanges(previous: AppState, next: AppState, uid: string, rememberSharedNames = false) {
    const batch = writeBatch(db);
    let writes = 0;
    if (changed(configurationOf(previous), configurationOf(next))) {
      batch.set(configurationDocument, firestoreDocument({ ...configurationOf(next), updatedAt: serverTimestamp(), updatedBy: uid }));
      batch.set(publicConfigurationDocument, firestoreDocument({ ...configurationOf(next), updatedAt: serverTimestamp() }));
      writes += 2;
    }

    const previousJobs = new Map(previous.jobs.map(job => [job.id, job]));
    const nextJobs = new Map(next.jobs.map(job => [job.id, job]));
    const peopleChanged = next.jobs.filter(job => {const old = previousJobs.get(job.id); return !old || old.customerRepresentative !== job.customerRepresentative || old.projectManager !== job.projectManager;});
    const names = peopleUpdates([...peopleChanged, ...peopleChanged.flatMap(job => previousJobs.get(job.id) ? [previousJobs.get(job.id)!] : [])]);
    if (rememberSharedNames && Object.keys(names).length) { batch.set(peopleDocument, names, {merge:true}); writes++; }
    next.jobs.forEach(job => {
      if (changed(previousJobs.get(job.id), job)) {
        job = rememberJobPeople(job, previousJobs.get(job.id));
        batch.set(doc(jobsCollection, job.id), firestoreDocument(job));
        if (isClosed(job, next)) batch.delete(doc(publicJobsCollection, job.id));
        else batch.set(doc(publicJobsCollection, job.id), publicJob(job));
        writes += 2;
      }
    });
    previous.jobs.forEach(job => {
      if (!nextJobs.has(job.id)) {
        batch.delete(doc(jobsCollection, job.id));
        batch.delete(doc(publicJobsCollection, job.id));
        writes += 2;
      }
    });

    const previousScans = new Map(previous.scans.map(scan => [scan.id, scan]));
    const nextScans = new Map(next.scans.map(scan => [scan.id, scan]));
    next.scans.forEach(scan => {
      if (changed(previousScans.get(scan.id), scan)) {
        batch.set(doc(scansCollection, scan.id), firestoreDocument(scan));
        writes += 1;
      }
    });
    previous.scans.forEach(scan => {
      if (!nextScans.has(scan.id)) {
        batch.delete(doc(scansCollection, scan.id));
        writes += 1;
      }
    });
    if (writes > 490) throw new Error("This update is too large to synchronize safely in one operation. Download a backup and contact the PlantFlow administrator.");
    if (writes) await batch.commit();
  },
};
