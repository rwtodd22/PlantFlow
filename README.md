# PlantFlow

PlantFlow is a browser-based production tracker for Worth Higgins & Associates. It creates Code 128 job labels, receives department-prefixed Bluetooth HID scanner input, tracks current job locations and statuses, and provides operational dashboards, management reports, and Excel backups.

## Local development

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
