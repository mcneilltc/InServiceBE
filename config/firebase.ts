require('dotenv').config();
const admin = require('firebase-admin');
const fs = require('fs');


// Check if Firebase has already been initialized
if (!admin.apps.length) {
  try {
    // jest.setup.js points FIRESTORE_EMULATOR_HOST at the local Firestore emulator
    // for every test run, so tests never touch the real "inservicetracker" project —
    // this is what stops a test's cleanup logic (e.g. wiping a collection in
    // beforeEach) from being able to delete real production data.
    if (process.env.FIRESTORE_EMULATOR_HOST) {
      const projectId = process.env.FIREBASE_PROJECT_ID || 'inservicetracker';
      admin.initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` });
      console.log(`Firebase Admin initialized against Firestore emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`);
    } else {
      // Serverless platforms (Vercel, etc.) have no persistent filesystem to read a
      // credentials file from, so the service account there must be the full JSON
      // pasted directly into an env var instead of a file path. Local dev keeps
      // using FIREBASE_SERVICE_ACCOUNT (a file path) unchanged below.
      const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
        : JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT, 'utf8'));

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL,
        // Cloud Storage must be enabled for this project in the Firebase console
        // before this bucket actually exists — see FIREBASE_STORAGE_BUCKET in .env.
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.appspot.com`,
      });

      console.log('Firebase Admin initialized successfully');
    }
  } catch (error) {
    console.error('Error initializing Firebase Admin:', error);
    throw error;
  }
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Optional: Add error handling for Firestore operations
db.settings({
  timestampsInSnapshots: true,
  ignoreUndefinedProperties: true
});

export { admin, db, bucket };
