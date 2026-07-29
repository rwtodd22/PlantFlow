import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyCSo6YfpvHE1hFcCCwr23WLY7yYjsGldEM",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "plant-flow-7b8f6.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "plant-flow-7b8f6",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "plant-flow-7b8f6.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "35971983955",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:35971983955:web:f4df7c5099cf6605f434a6",
};

export const firebaseConfigured = Object.values(firebaseConfig).every(Boolean);

if (!firebaseConfigured) {
  throw new Error("PlantFlow Firebase configuration is incomplete. Check the VITE_FIREBASE_* environment variables.");
}

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
