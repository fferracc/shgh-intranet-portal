import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FORMS_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FORMS_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FORMS_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FORMS_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FORMS_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FORMS_FIREBASE_APP_ID
};

// Initialize Firebase for the refugees app
const appName = "refugees-app";
const app = getApps().find(app => app.name === appName)
    ? getApp(appName)
    : initializeApp(firebaseConfig, appName);

const db = getFirestore(app);

export { app, db };
