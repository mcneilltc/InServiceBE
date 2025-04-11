const admin = require('firebase-admin');

// Check if Firebase has already been initialized
if (!admin.apps.length) {
  try {
    const serviceAccount = require('../inservicetracker-firebase-adminsdk-fbsvc-9b2f1990ed.json');

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      // Add your Firebase project's database URL
      databaseURL: "https://console.firebase.google.com/u/0/project/inservicetracker/firestore/databases/-default-/data" // Replace with your actual database URL
    });

    console.log('Firebase Admin initialized successfully');
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

module.exports = { admin, db }; 