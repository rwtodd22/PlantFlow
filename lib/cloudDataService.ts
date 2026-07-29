import { Unsubscribe, collection, deleteDoc, doc, getDoc, onSnapshot, serverTimestamp, setDoc, writeBatch } from "firebase/firestore";
import { db } from "../src/firebase";
import { AppState, Job, ScanEvent, seedState } from "./dataService";

const configurationDocument = doc(db, "configuration", "plantflow");
const jobsCollection = collection(db, "jobs");
const scansCollection = collection(db, "scanEvents");
const publicConfigurationDocument = doc(db, "publicConfiguration", "plantflow");
const publicJobsCollection = collection(db, "publicJobs");

type Configuration = Pick<AppState, "departments" | "statuses" | "settings">;

function configurationOf(state: AppState): Configuration {
  return { departments: state.departments, statuses: state.statuses, settings: state.settings };
}

function changed(left: unknown, right: unknown) {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function publicJob(job: Job): Job {
  return { ...job, notes: "" };
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
      onSnapshot(scansCollection, snapshot => {
        scansLoaded = true;
        scans = snapshot.docs.map(item => item.data() as ScanEvent);
        emit();
      }, onError),
    ];
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
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
    batch.set(configurationDocument, { ...configurationOf(state), updatedAt: serverTimestamp(), updatedBy: uid });
    batch.set(publicConfigurationDocument, { ...configurationOf(state), updatedAt: serverTimestamp() });
    state.jobs.forEach(job => batch.set(doc(jobsCollection, job.id), job));
    state.jobs.forEach(job => batch.set(doc(publicJobsCollection, job.id), publicJob(job)));
    state.scans.forEach(scan => batch.set(doc(scansCollection, scan.id), scan));
    await batch.commit();
  },

  async ensurePublicState(state: AppState) {
    if ((await getDoc(publicConfigurationDocument)).exists()) return;
    if (1 + state.jobs.length > 490) throw new Error("The public viewer contains too many jobs for its initial one-step publication.");
    const batch = writeBatch(db);
    batch.set(publicConfigurationDocument, { ...configurationOf(state), updatedAt: serverTimestamp() });
    state.jobs.forEach(job => batch.set(doc(publicJobsCollection, job.id), publicJob(job)));
    await batch.commit();
  },

  async saveChanges(previous: AppState, next: AppState, uid: string) {
    const promises: Promise<unknown>[] = [];
    if (changed(configurationOf(previous), configurationOf(next))) {
      promises.push(setDoc(configurationDocument, { ...configurationOf(next), updatedAt: serverTimestamp(), updatedBy: uid }));
      promises.push(setDoc(publicConfigurationDocument, { ...configurationOf(next), updatedAt: serverTimestamp() }));
    }

    const previousJobs = new Map(previous.jobs.map(job => [job.id, job]));
    const nextJobs = new Map(next.jobs.map(job => [job.id, job]));
    next.jobs.forEach(job => {
      if (changed(previousJobs.get(job.id), job)) {
        promises.push(setDoc(doc(jobsCollection, job.id), job));
        promises.push(setDoc(doc(publicJobsCollection, job.id), publicJob(job)));
      }
    });
    previous.jobs.forEach(job => {
      if (!nextJobs.has(job.id)) {
        promises.push(deleteDoc(doc(jobsCollection, job.id)));
        promises.push(deleteDoc(doc(publicJobsCollection, job.id)));
      }
    });

    const previousScans = new Map(previous.scans.map(scan => [scan.id, scan]));
    const nextScans = new Map(next.scans.map(scan => [scan.id, scan]));
    next.scans.forEach(scan => {
      if (changed(previousScans.get(scan.id), scan)) promises.push(setDoc(doc(scansCollection, scan.id), scan));
    });
    previous.scans.forEach(scan => {
      if (!nextScans.has(scan.id)) promises.push(deleteDoc(doc(scansCollection, scan.id)));
    });
    await Promise.all(promises);
  },
};
