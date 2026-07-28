require('dotenv').config();
const admin = require('firebase-admin');
const fs = require('fs');


// Check if Firebase has already been initialized
if (!admin.apps.length) {
  try {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT;
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')); // Read and parse the file
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
      // Cloud Storage must be enabled for this project in the Firebase console
      // before this bucket actually exists — see FIREBASE_STORAGE_BUCKET in .env.
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.appspot.com`,
    });

    console.log('Firebase Admin initialized successfully');
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
