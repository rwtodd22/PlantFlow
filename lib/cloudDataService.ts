import { Unsubscribe, collection, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, serverTimestamp, startAfter, writeBatch } from "firebase/firestore";
import { db } from "../src/firebase";
import { AppState, Job, ScanEvent, seedState } from "./dataService";

const configurationDocument = doc(db, "configuration", "plantflow");
const jobsCollection = collection(db, "jobs");
const scansCollection = collection(db, "scanEvents");
const publicConfigurationDocument = doc(db, "publicConfiguration", "plantflow");
const publicJobsCollection = collection(db, "publicJobs");
const LIVE_SCAN_LIMIT = 300;
const HISTORY_PAGE_SIZE = 250;

type Configuration = Pick<AppState, "departments" | "statuses" | "settings">;

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

export const cloudDataService = {
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

  async saveChanges(previous: AppState, next: AppState, uid: string) {
    const batch = writeBatch(db);
    let writes = 0;
    if (changed(configurationOf(previous), configurationOf(next))) {
      batch.set(configurationDocument, firestoreDocument({ ...configurationOf(next), updatedAt: serverTimestamp(), updatedBy: uid }));
      batch.set(publicConfigurationDocument, firestoreDocument({ ...configurationOf(next), updatedAt: serverTimestamp() }));
      writes += 2;
    }

    const previousJobs = new Map(previous.jobs.map(job => [job.id, job]));
    const nextJobs = new Map(next.jobs.map(job => [job.id, job]));
    next.jobs.forEach(job => {
      if (changed(previousJobs.get(job.id), job)) {
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
