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

## Current data storage

This prototype stores job data in each browser's local storage. Data is not yet shared across computers. A shared database such as Firebase/Firestore is the planned next step before multi-station production use.
