# PlantFlow

PlantFlow is a browser-based production tracker for Worth Higgins & Associates. It creates Code 128 job labels, receives department-prefixed Bluetooth HID scanner input, tracks current job locations and statuses, and provides operational dashboards, management reports, and Excel backups.

## Local development

Requirements: Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:3000/`.

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
