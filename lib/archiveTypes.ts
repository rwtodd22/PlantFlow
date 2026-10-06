import type { Department, Job, StatusDefinition } from "./dataService";
export type ArchiveSort = "newest" | "oldest" | "job" | "customer";
export type ArchivedJob = { id: string; job: Job; departments: Department[]; statuses: StatusDefinition[]; archivedAt: { toDate(): Date }; archivedBy: string; historyStatus?: "capturing" | "complete"; historyEventCount?: number; historyCodes?: string[] };
export type ArchivePage = { records: ArchivedJob[]; cursor?: unknown; hasMore: boolean };
export type ArchiveLoader = (sort: ArchiveSort, cursor?: unknown) => Promise<ArchivePage>;
