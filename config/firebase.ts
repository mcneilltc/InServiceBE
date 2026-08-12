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
      admin.initializeApp({ projectId });
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
      });

      console.log('Firebase Admin initialized successfully');
    }
  } catch (error) {
    console.error('Error initializing Firebase Admin:', error);
    throw error;
  }
}

const db = admin.firestore();

// Optional: Add error handling for Firestore operations
db.settings({
  timestampsInSnapshots: true,
  ignoreUndefinedProperties: true
});

export { admin, db };
