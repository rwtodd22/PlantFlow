# PlantFlow

PlantFlow is a browser-based production tracker for Worth Higgins & Associates. It creates Code 128 job labels, receives department-prefixed Bluetooth HID scanner input, tracks current job locations and statuses, and provides operational dashboards, management reports, and Excel backups.

## Local development

### Return a completed job to production

Administrators can choose **Return to Production** beside a job in Ready for
Billing. Choose an active status and department, or choose the specific parts to
reopen. The online transaction refreshes the job/configuration, refuses archived
or deletion-pending records, clears completion/approval metadata, retains both
production and billing notes, restores the public copy, and records each change
in movement history. A failure leaves the dialog open without an optimistic
success. Up to five parts can be returned atomically within Firestore's security
rule access limits; additional parts can then be changed in Active Jobs.
Existing deployed rules support this operation; no new rules publication is
needed. Regression coverage is included in `tests/return-to-production.mjs` via
the emulator suite.

### Administrator mistaken-job deletion (2026-10-07, coordinated rollout)

Deploy the reviewed `firestore.rules` together with this application change. Do not
loosen the archive rules or reinstate unrestricted job deletion. A Git push alone
does not deploy Firestore rules. Compare the live rules before publishing; the
rules were published with explicit owner approval on 2026-10-07 at 12:16 PM
America/New_York. The console's saved active version was verified after reload;
the staged rules matched the tested local file before publication.

Enabled `admin` and `super_admin` profiles may explicitly delete a mistaken job
after typing `DELETE <job number>`. The typed phrase is an accident-prevention
measure, not an authentication secret. Firestore enforces the role, exact source
snapshot, authenticated actor, server timestamp, and separate deletion receipt.
Approved jobs must first have their billing approval removed. Archived jobs and
their archived history cannot use this path and remain immutable.

Deletion creates a pending `jobDeletions/<stable job id>` receipt, freezes job
edits, and locks its current barcodes in `deletionHistoryLocks`. It then deletes
history in small batches (including stable-ID history under earlier barcodes).
Only after cleanup does it atomically remove the private/public job, release
the barcode locks, and complete the receipt. The completed receipt retains the
job number, barcode list, confirmation, actor IDs, and timestamps—not the job
snapshot. This prevents stale clients from recreating that job ID while allowing
the job number to be reused with a new ID. Legacy events without a job ID still
have only barcode-based attribution, the same limitation as archive capture.

If interrupted, reopen Review Job and repeat the same confirmed deletion; the
operation resumes. Another enabled administrator may finish it. Do not manually
delete pending receipts/locks. The old bulk-reset service now refuses **before**
deleting anything, since its former sequential cleanup could delete history and
public copies before protected job deletion failed. Old already-open clients
still have the previously documented legacy-reset limitation; refresh clients
during rollout.

Validation: `npm run build`; with the local demo Firestore emulator on port 8187,
`node tests/emulator.mjs` and `node tests/role-compatibility.mjs`. Tests cover
511-event cleanup, 26-part jobs, denied roles/forgeries, immutable archives and
receipts, approved-job rejection, interruption/retry, number reuse, and unchanged
ordinary permissions. Tests use disposable emulator data only.

Requirements: Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:3000/`.

## Viewer links

- Sales & Project Management Portal: `http://127.0.0.1:3000/?view=portal`
  - Public, real-time, and read-only.
  - Includes personal per-device filters, stars, notes, themes, and PDF output.
- Production Floor Portal: `http://127.0.0.1:3000/?view=production`
  - Production employees sign in with an employee name and fixed passcode assigned by a Super Admin; no employee email address is required.
  - Provides phone-friendly background scanner input and controls for location, status, and shared production notes.
  - Expanded jobs include barcode reprint and split-job actions similar to Active Jobs.
  - Split jobs retain separate location and status controls for each tracked part.

## Account access

- Super Admin and Admin accounts use Firebase email/password sign-in and can open the main PlantFlow workspace.
- Super Admin and Admin accounts can also open the Production Floor Portal using their administrator email and the same assigned PlantFlow password.
- Only Super Admins can create, disable, restore, or remove accounts.
- Production Floor accounts cannot open the main workspace. They use the Production Floor Portal link with the employee name and passcode assigned during account creation.
- Production Floor sessions use persistent Firebase authentication and remain active during a shift. After 12 hours without activity, the employee must sign in again.
- Production Floor passcodes do not have an employee-facing reset workflow. If access should change, a Super Admin can disable or remove the account and create a replacement.

Both links are generated from the current site address in Administration, so the
same cards automatically use the deployed Vercel address in production.

Portal layouts retain full tables on desktop screens and switch to stacked job
cards on phone and tablet widths. Summary metrics and search/filter controls are
collapsed by default on both portals to keep the working view focused on jobs.

## Production build

```bash
npm run build
npm run preview
```

## Deployment

The app is configured as a standard React/Vite project. Vercel should use:

- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`

## Data storage and history

PlantFlow uses Firebase Authentication and Cloud Firestore for shared, real-time production data. Trusted browsers use Firestore's persistent local cache so queued reads and writes survive brief network interruptions and browser restarts.

- Every active job is loaded; active-job visibility is never capped by the history paging limit.
- The newest 300 movement events are subscribed to in real time.
- Older movement history remains in Firestore and loads in 250-event pages from Job History.
- Completed jobs move into the collapsed Ready for Billing folder and remain there while awaiting billing review.
- When the optional retention toggle is enabled, only jobs marked OK to Bill are automatically cleared 30 days after approval. Awaiting Review and Billing Hold records remain indefinitely.
- Canceled jobs are excluded from active production and are not included in the automatic billing cleanup.
- Clearing an approved job from Ready for Billing removes the closed job record while retaining its movement events.


## Local Billing Archive review (not deployed)

This review copy starts from GitHub main `3454178fb53148a688e1300525a4b5b44e9111a7` and preserves the three pre-existing Starting Location edits. The original checkout has not been modified.

- Billing's explicit Archive approved jobs action replaces Clear approved from folder. The server-current complete, approved job is copied in full into immutable `archivedJobs/{jobId}` with the department/status definitions, archive time and user ID. Its `jobs` and `publicJobs` entries are removed in the same transaction; movement events remain unchanged.
- Archive is collapsed initially and unmounted when closed or leaving Billing. Opening fetches at most 25 records. Sort changes restart the query; Load more uses a document-snapshot cursor. Options: archived newest/oldest, job number A–Z, customer A–Z. Reopening fetches a fresh first page. There is no archive listener and no background all-history query.
- Only Admin/Super Admin can read or create archives. Proposed rules enforce an exact source copy and atomic source removal, prohibit archive modification/deletion and prevent old clients recreating the archived ID.
- Automatic billing deletion is disabled in this version; the legacy setting is retained without executing it. No migrations, backfills, exports, restore-to-production action or live changes are included. Previously deleted details cannot be recovered by this feature. Existing Excel backup does not include the new archive; future Excel export is explicitly deferred.
- Existing unrelated whole-state retry/concurrent-edit findings are not repaired. Rules guard archived IDs, but stale clients may receive a rejected save. Already-open old app sessions must be addressed before rollout because they can still perform legacy cleanup on unarchived jobs.

### Validation and review

`npm run build -- --configLoader runner` passes. The config-loader flag avoids writing through the shared read-only dependency link.

`node tests/emulator.mjs` runs against a local Firestore emulator only, project `demo-plantflow-archive`, port 8187. Tests transpile the actual service while replacing its Firebase instance with the emulator client. Rules compilation, archive transaction, preservation, authorization, immutability, stale recreation, approval/completion checks, atomic rejection, idempotency and all sort cursors are covered.

`node tests/preview.mjs` uses an isolated headless Chromium and blocks non-local requests. It covers initial zero archive reads, Billing transition, split-job detail, 25/50/51 paging, sorting, rapid sorting, close/re-entry and desktop/mobile rendering. Test dependencies are isolated in sibling `archive-validation`; generated test modules are disposable.

Sample-only review URL: `http://127.0.0.1:4317/preview/`. Start with `node node_modules/vite/bin/vite.js --config preview.config.ts --configLoader runner`. This entry imports the real Billing/Archive components but no Firebase module. No export controls are present.

### Release evidence and gates

Read-only GitHub check confirmed remote main equals local HEAD. GitHub's latest listed Vercel Production deployment is successful deployment 6515084147 of `33424a59aa0386044ac2e27bff6a2a439fe830ac`, created 2026-09-18. The deployment uses a SHA ref; its current production alias, configured production branch and current push-trigger settings have not been verified. Do not infer that pushing is safe or that this record is the currently served alias. Commit 3454178 changes only production-portal colors/styles relative to that recorded deployment.

Before release: user reviews the tested local preview; verify current Vercel branch/alias and automatic-deployment settings; validate deployed Firestore rules/index settings against the proposed rules; coordinate old browser sessions; obtain explicit approval before push/deploy. This feature requires the new archive rules to work. Default single-field indexes support the four sort queries; any deployed exemptions must be checked.


## Department-history checkpoint

The local review now includes Data / Department History inside Review Job and archived job details. It uses recorded event timestamps, not the editable job.updatedAt clock. It shows arrival, departure/end, elapsed duration, repeat visits and independent part routes. Same-department observations do not restart arrival time. Closing-status events end a visit and are labeled as a status boundary, not proof of physical departure. Ongoing active durations update every 30 seconds; no extra scans or clock-in/out steps are required. Time is continuous elapsed time including queues and waiting, not hands-on labor or business-hours time.

New scanner/manual events include stable jobId, recorded timestamp basis and closing-status metadata where applicable. Manual job-editor location/status changes use the actual action timestamp even when the separate Time Here display is adjusted. Historical timestamps are displayed as recorded. Unknown arrivals/departures, invalid times, conflicting timestamp ties and legacy manual/association uncertainty are explicitly identified. Deleted history and unlinked history under old renamed/reused barcodes cannot be reconstructed. The display states the browser IANA timezone and includes the local timezone abbreviation in timestamps.

Archive history uses a resumable two-phase capture. The initial transaction preserves the current job/configuration snapshot, removes active/public copies and creates temporary barcode history locks with historyStatus=capturing. All available matching source events are read from the server in 200-document pages, including stable-job-ID events under older barcodes and legacy current-code matches; event IDs deduplicate overlap. Exact event snapshots are copied into archivedJobs/{jobId}/events/{sourceDocumentId} in 15-write batches to stay within security-rule document-access budgets. Deterministic IDs make partial batches replayable. A final transaction marks complete/count/capture time and releases temporary locks. The UI exposes pending capture and Retry history capture; pending records are not presented as complete. Full history is fetched only when the data section is opened, separately from the bounded archive list. Original events remain in scanEvents.

Additional required rules: archiveHistoryLocks creation/removal, source-event write protection while capture is pending, stable-job-ID protection after archival, exact-copy archive event writes while capturing, immutable completed event copies, and narrowly allowed capture-status finalization. These replace the earlier archive-only rules proposal. Temporary locks can reject older clients' event writes for affected barcodes until capture finishes; completed/approved jobs should be archived during a coordinated rollout. Existing unrelated whole-state concurrency/retry problems are unchanged.

Validation: tests/department-history.mjs passes repeat visits, duplicates, status-only observations, closure/reopening, timestamp ties, independent split routes, missing/invalid boundaries, stable-ID renames and ignoring editable clocks. Expanded emulator tests pass 322-event capture, old-barcode stable-ID inclusion, interrupted capture, protected source events/barcode reuse, partial-page replay, immutable archive copies and archived-history survival after later legacy-source removal. Browser tests pass lazy Data opening, readable archived timeline, ongoing active duration and existing archive/pagination/re-entry behavior. Production build passes with the existing bundle-size warning. The preview has Create Job, Jobs / Data, and Billing / Archive navigation. It is a sample-only feature review, not the full live application.


## Saved people and route-summary review (October 6)

Customer Representative and Project Manager are independent optional fields on main Create Job, Job Intake, and Review Job. Each selector starts with no invented roster and includes Add New. Names are trimmed, whitespace-normalized, case-insensitively deduplicated for display, and saved when the job is saved. Names previously used on a job remain in separate saved-name arrays on that job when assignments change; these also contribute reusable choices across loaded jobs. Admin saves and archival additionally remember names with atomic arrayUnion in configuration/jobPeople. Other roles do not need configuration write permission: their job fields and saved-name arrays use existing job permissions. Archival preserves these fields and remembers both name lists before removing the active job. Internal saved-name arrays are stripped from public copies; current assignments remain part of job details. No security rules were changed in this follow-up; prior archive rule proposal remains in the review copy and is not deployed.

Department History initially shows the department route, separate for each part and retaining repeated visits. Expand Show detailed scan-by-scan history for visit timestamps/durations and every loaded event. The existing timestamp derivation, unknown-time warnings, lazy loading and archive capture remain intact. Billing still requires manual checkbox selection and Archive approved jobs.

Preview: http://127.0.0.1:4317/preview/ . Sample changes persist only in this browser's localStorage under plantflow-feature-preview-v2. No Firebase connection. Create a sample job, edit it under Jobs / Data, mark it complete, then approve/select/archive under Billing / Archive. Preview form is intentionally limited to this feature review; the real app retains its complete intake fields. Tests block external browser requests. No push, deployment, live database write or export occurred.

Validation: production TypeScript/Vite build passes (existing bundle-size warning); timing derivation tests pass; emulator covers actual service create/edit/independent saved lists and retained prior names plus all archive scenarios; browser tests cover empty separate lists, Add New, reload/edit/archive persistence, prior-name reuse, repeated department visits and pagination. Screenshots are under preview/.


## Production release checkpoint

Prepared on release/plantflow-archive-people from GitHub main 3454178fb53148a688e1300525a4b5b44e9111a7. The original checkout's three uncommitted starting-location-toggle edits are preserved there and excluded here. Vercel project wayne-todds-projects/plant-flow confirms main as production branch and plant-flow-eta.vercel.app as production alias; current production is 33424a59aa0386044ac2e27bff6a2a439fe830ac. Main's existing portal-color commit therefore also reaches production when main is updated.

Release is blocked before push: both available Firebase browser accounts cannot open plant-flow-7b8f6. Obtain the existing owner's authorized Firebase session; inspect deployed rules and indexes before applying changes. Proposed rules need explicit action-time approval. They add Admin/Super Admin archive reads and exact-copy creation, temporary source-history locks, immutable copied events, capture-finalization metadata updates, and archived-ID recreation protection. They restrict writes during capture; they do not grant public archive access or expand user roles. Managers retain billing review but Archive controls are disabled to match the approved-role proposal. The rules diff is relative to repository rules, not yet the deployed rules.

Required existing single-field indexes: archivedJobs.archivedAt ascending/descending, archivedJobs.job.jobNumber ascending, archivedJobs.job.customer ascending, scanEvents.jobId and scanEvents.jobNumber for equality/in queries with document-ID pagination, plus existing scanEvents.timestamp descending. No new composite query is expected; deployed exemptions remain unverified.

Activation order: confirm access and deployed dependencies; obtain exact rule approval; coordinate all operators to close old PlantFlow tabs, including offline sessions, since old clients can still delete unarchived approved jobs with 90-day cleanup; deploy and verify rules/index readiness; fast-forward authorized main and verify Vercel deployment/alias; operators open the refreshed app before any Archive use. No record migration, automatic archival or cleanup is part of this release. Do not roll back to old destructive billing behavior without coordinating clients and retaining archive-compatible rules. Current live cleanup flag and open-client state are not verified.


## Verified baseline reconciliation

The browser owner verified project plant-flow-7b8f6/(default), starred published rules version Jul 29, 2026 2:12 AM as displayed. Selecting it exactly matched the supplied console rules; the rules-version loading error cleared. The verified source is preserved in tests/published-baseline.rules. It matches repository commit 3518ecd. Later commits ed3eb1f and a570380 changed ordinary permissions in the repository; those changes were inherited by the initial proposal but are unrelated to Archive and are now excluded.

Reconciled firestore.rules preserves published configuration/job reads, standard-user create/delete and priority permissions, standard-user due-date restriction on private jobs, and existing publicJobs update permissions. It does not enable job_creator access; that existing intake role remains unsupported by this published baseline and is outside this release's rule scope. Saved-name fields use existing job-write permissions; the shared name configuration remains Admin/Super Admin writable. Only archive collection/capture permissions and archive-specific conflict/recreation protections are added. Tests compare 112 ordinary access outcomes across eight roles against the verified baseline, separately from the archive capture tests.

Browser inspection reports automatic collection indexing enabled, collection-group indexing disabled, and no manual indexes/exemptions visible. The feature uses collection queries, not collection-group queries. No index change is currently proposed.

Approval target: publish the reconciled firestore.rules to plant-flow-7b8f6/(default). Permit existing Admin/Super Admin users to create/read exact job/history archive snapshots and finalize capture metadata; prohibit completed archive edits/deletes; use temporary barcode locks to block conflicting event writes/reuse during capture; prevent recreation of archived job IDs and later writes to events linked to those archived IDs. Ordinary role permissions and public-read scope remain as published. No real-data migration or automatic archive operation is included. Specific action-time approval and operator old-tab coordination are still required; nothing has been published or pushed.


## Proposed deletion safeguard — separate approval pending

The release's proposed /jobs delete rule now requires Admin/Super Admin access and a newly created exact archive snapshot in the same atomic commit, with capture state and server-time/actor metadata. This blocks old billing Clear and queued 90-day deletion batches even if the tab was opened before rollout. The archive create rules validate the snapshot and removal together. Ordinary private-job deletes (all roles), including reset's jobs phase, are denied; public-job deletion remains allowed so completion/public cleanup works. No other ordinary role permissions change.

Emulator validation covers 112 permission outcomes with precisely four changed ordinary-delete outcomes (super_admin/admin/manager/standard); old Clear/queued cleanup atomic rejection with both current/public records and unrelated writes preserved; scanning and edits; public cleanup; valid archive; and reset limitations. No real data was used.

CRITICAL LIMIT: old clearAllJobData deletes scanEvents, then publicJobs, then jobs in separate commits. This jobs-only safeguard denies its final phase but does not block the earlier scan/public deletions. Therefore do not use Reset while old clients remain. This is not protection against all administrative deletion commands or stale overwrites. A broader source-history-deletion restriction, plus disabling Reset in the new UI, would require a separately scoped and tested proposal; it is not silently included here. This revision addresses the automatic cleanup/manual billing Clear risk without requiring proof that all tabs closed. Staff should still refresh; rejected old writes may show sync errors.

Combined approval wording: Publish the proposed rules to plant-flow-7b8f6/(default), enabling Admin/Super Admin archive snapshot/capture access and archive-specific history/recreation protections, and requiring an exact archive copy in the same transaction before any /jobs deletion. This intentionally disables ordinary permanent job deletion and reset's jobs phase; scanning, editing, public cleanup and all other existing role permissions remain unchanged. It does not stop old Reset from separately deleting source scan history/public copies. No rule publication, code push or live data operation has occurred.
