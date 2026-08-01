// Fixed test-only secret so requireRole middleware and __tests__/testHelpers.ts
// sign/verify against the same value, independent of the real .env file.
process.env.SESSION_SECRET = 'test-session-secret';

// Route all Firestore access in tests to the local emulator (started via
// `firebase emulators:exec` in the npm test scripts) instead of the real
// "inservicetracker" production project. Without this, a test's cleanup logic
// (e.g. a beforeEach that clears a collection) deletes real production data.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'inservicetracker';
