export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');
const { findDuplicateSheetSession, findSimilarSheetSession } = require('../services/sheetDuplicateCheck');

// Runs against the local Firestore emulator (see jest.setup.js).
describe('Upload Sheet duplicate detection', () => {
  const createdEmployeeIds: string[] = [];
  const createdSessionIds: string[] = [];

  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) await db.collection('employees').doc(id).delete();
    for (const id of createdSessionIds.splice(0)) await db.collection('sessions').doc(id).delete();
  });

  async function makeEmployee(overrides: Record<string, any> = {}) {
    const ref = await db.collection('employees').add({
      name: 'Test Lifeguard',
      homeLocation: 'MCAC',
      ...overrides,
    });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  describe('findDuplicateSheetSession', () => {
    it('returns null when no session has a matching hash', async () => {
      const result = await findDuplicateSheetSession(['hash-that-does-not-exist']);
      expect(result).toBeNull();
    });

    it('returns null for an empty hash list', async () => {
      const result = await findDuplicateSheetSession([]);
      expect(result).toBeNull();
    });

    it('finds a session sharing at least one image hash', async () => {
      const ref = await db.collection('sessions').add({
        date: '2026-06-01',
        location: 'ERRC',
        source: 'upload-sheet',
        sheetImageHashes: ['hash-a', 'hash-b'],
      });
      createdSessionIds.push(ref.id);

      // Overlaps on 'hash-b' only — a subset match still counts, since
      // re-uploading even one page of an already-processed packet should
      // still be caught.
      const result = await findDuplicateSheetSession(['hash-b', 'hash-c']);
      expect(result).toEqual({ sessionId: ref.id, date: '2026-06-01', location: 'ERRC' });
    });

    it('does not match a session with entirely different hashes', async () => {
      const ref = await db.collection('sessions').add({
        date: '2026-06-01',
        location: 'ERRC',
        source: 'upload-sheet',
        sheetImageHashes: ['hash-x'],
      });
      createdSessionIds.push(ref.id);

      const result = await findDuplicateSheetSession(['hash-y', 'hash-z']);
      expect(result).toBeNull();
    });
  });

  describe('findSimilarSheetSession', () => {
    it('flags a same-date/location upload-sheet session sharing a topic', async () => {
      const ref = await db.collection('sessions').add({
        date: '2026-06-01',
        location: 'ERRC',
        source: 'upload-sheet',
        trainer: ['trainer-x'],
        topics: ['CPR/AED for the Professional Rescuer'],
      });
      createdSessionIds.push(ref.id);

      const result = await findSimilarSheetSession(
        '2026-06-01',
        'ERRC',
        ['trainer-y'], // different trainer
        ['CPR/AED for the Professional Rescuer'], // same topic
      );
      expect(result).toEqual({
        sessionId: ref.id,
        date: '2026-06-01',
        location: 'ERRC',
        trainer: ['trainer-x'],
        topics: ['CPR/AED for the Professional Rescuer'],
      });
    });

    it('flags a same-date/location session sharing a trainer even with no topic overlap', async () => {
      const ref = await db.collection('sessions').add({
        date: '2026-06-01',
        location: 'ERRC',
        source: 'upload-sheet',
        trainer: ['trainer-x'],
        topics: ['First Aid'],
      });
      createdSessionIds.push(ref.id);

      const result = await findSimilarSheetSession('2026-06-01', 'ERRC', ['trainer-x'], ['Lifeguarding']);
      expect(result?.sessionId).toBe(ref.id);
    });

    it('does not flag when date differs', async () => {
      const ref = await db.collection('sessions').add({
        date: '2026-06-01',
        location: 'ERRC',
        source: 'upload-sheet',
        trainer: ['trainer-x'],
        topics: ['First Aid'],
      });
      createdSessionIds.push(ref.id);

      const result = await findSimilarSheetSession('2026-06-02', 'ERRC', ['trainer-x'], ['First Aid']);
      expect(result).toBeNull();
    });

    it('does not flag when neither trainer nor topic overlaps', async () => {
      const ref = await db.collection('sessions').add({
        date: '2026-06-01',
        location: 'ERRC',
        source: 'upload-sheet',
        trainer: ['trainer-x'],
        topics: ['First Aid'],
      });
      createdSessionIds.push(ref.id);

      const result = await findSimilarSheetSession('2026-06-01', 'ERRC', ['trainer-y'], ['Lifeguarding']);
      expect(result).toBeNull();
    });

    it('ignores non-upload-sheet sessions (e.g. manually added trainings)', async () => {
      const ref = await db.collection('sessions').add({
        date: '2026-06-01',
        location: 'ERRC',
        trainer: ['trainer-x'],
        topics: ['First Aid'],
        // no source field — a normal Add Training session
      });
      createdSessionIds.push(ref.id);

      const result = await findSimilarSheetSession('2026-06-01', 'ERRC', ['trainer-x'], ['First Aid']);
      expect(result).toBeNull();
    });
  });

  describe('POST /api/sessions/from-sheet', () => {
    it('creates a session and stores its image hashes', async () => {
      const employeeId = await makeEmployee();
      const trainerId = await makeEmployee({ name: 'Test Trainer', isTrainer: true });

      const response = await request(app)
        .post('/api/sessions/from-sheet')
        .set('Cookie', authCookie())
        .send({
          date: '2026-08-01',
          location: 'MCAC',
          startTime: '09:00',
          endTime: '10:00',
          length: 1,
          topics: ['Inservice Training'],
          trainer: [trainerId],
          trainees: [{ employeeId, name: 'Test Lifeguard' }],
          sheetImageUrls: ['https://example.com/sheet.jpg'],
          sheetImageHashes: ['unique-hash-1'],
        });

      expect(response.status).toBe(201);
      createdSessionIds.push(response.body.sessionId);

      const saved = await db.collection('sessions').doc(response.body.sessionId).get();
      expect(saved.data().sheetImageHashes).toEqual(['unique-hash-1']);
    });

    it('saves (does not block) a session flagged as a possible duplicate, and records the flag', async () => {
      const employeeId = await makeEmployee();
      const trainerId = await makeEmployee({ name: 'Test Trainer', isTrainer: true });

      const flaggedOf = await db.collection('sessions').add({
        date: '2026-06-01',
        location: 'ERRC',
        source: 'upload-sheet',
        trainer: [trainerId],
        topics: ['First Aid'],
      });
      createdSessionIds.push(flaggedOf.id);

      const response = await request(app)
        .post('/api/sessions/from-sheet')
        .set('Cookie', authCookie())
        .send({
          date: '2026-08-01',
          location: 'MCAC',
          startTime: '09:00',
          endTime: '10:00',
          length: 1,
          topics: ['Inservice Training'],
          trainer: [trainerId],
          trainees: [{ employeeId, name: 'Test Lifeguard' }],
          sheetImageHashes: ['unrelated-hash'],
          flaggedAsPossibleDuplicateOf: flaggedOf.id,
        });

      expect(response.status).toBe(201);
      createdSessionIds.push(response.body.sessionId);

      const saved = await db.collection('sessions').doc(response.body.sessionId).get();
      expect(saved.data().flaggedAsPossibleDuplicateOf).toBe(flaggedOf.id);

      // Hours were still credited — this is a warning, not a block.
      const empDoc = await db.collection('employees').doc(employeeId).get();
      expect(empDoc.data().totalHours).toBeGreaterThan(0);
    });

    it('rejects a sheet whose image hash matches an already-saved session', async () => {
      const employeeId = await makeEmployee();
      const trainerId = await makeEmployee({ name: 'Test Trainer', isTrainer: true });

      const existing = await db.collection('sessions').add({
        date: '2026-07-01',
        location: 'ERRC',
        source: 'upload-sheet',
        sheetImageHashes: ['dupe-hash'],
      });
      createdSessionIds.push(existing.id);

      const response = await request(app)
        .post('/api/sessions/from-sheet')
        .set('Cookie', authCookie())
        .send({
          date: '2026-08-01',
          location: 'MCAC',
          startTime: '09:00',
          endTime: '10:00',
          length: 1,
          topics: ['Inservice Training'],
          trainer: [trainerId],
          trainees: [{ employeeId, name: 'Test Lifeguard' }],
          sheetImageHashes: ['dupe-hash'],
        });

      expect(response.status).toBe(409);
      expect(response.body.error.duplicateSessionId).toBe(existing.id);

      // Confirm no hours were credited off the back of the rejected request —
      // the whole point of checking before creating the session.
      const empDoc = await db.collection('employees').doc(employeeId).get();
      expect(empDoc.data().totalHours || 0).toBe(0);
    });
  });
});
