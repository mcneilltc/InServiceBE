export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// Runs against the local Firestore emulator (see jest.setup.js).
describe('Inservice sheet submission rules', () => {
  const createdSessionIds: string[] = [];

  afterEach(async () => {
    for (const id of createdSessionIds.splice(0)) {
      await db.collection('sessions').doc(id).delete();
      const checkins = await db.collection('checkins').where('sessionId', '==', id).get();
      await Promise.all(checkins.docs.map((d: any) => d.ref.delete()));
    }
  });

  it('does not generate an inservice sheet for a session with zero check-ins', async () => {
    const ref = await db.collection('sessions').add({
      date: '2026-06-01',
      startTime: '09:00 AM',
      location: 'MCAC',
      length: 2,
      status: 'scheduled',
      topics: ['CPR'],
      trainer: ['trainer-zero-checkins'],
      trainees: [],
    });
    createdSessionIds.push(ref.id);

    const response = await request(app)
      .post(`/api/sessions/${ref.id}/close`)
      .set('Cookie', authCookie());

    expect(response.status).toBe(200);

    const saved = await db.collection('sessions').doc(ref.id).get();
    expect(saved.data().status).toBe('completed');
    expect(saved.data().inserviceSheetKey).toBeUndefined();
  });

  it('blocks closing out a session whose time overlaps one the same trainer already submitted a sheet for', async () => {
    const existing = await db.collection('sessions').add({
      date: '2026-06-02',
      startTime: '09:00 AM',
      location: 'MCAC',
      length: 2,
      status: 'completed',
      topics: ['CPR'],
      trainer: ['trainer-overlap'],
      inserviceSheetKey: 'inservice-sheets/2026/06/already-submitted.docx',
    });
    createdSessionIds.push(existing.id);

    const conflicting = await db.collection('sessions').add({
      date: '2026-06-02',
      startTime: '09:30 AM', // overlaps 9:00-11:00
      location: 'MCAC',
      length: 1,
      status: 'scheduled',
      topics: ['First Aid'],
      trainer: ['trainer-overlap'],
      trainees: [],
    });
    createdSessionIds.push(conflicting.id);

    const response = await request(app)
      .post(`/api/sessions/${conflicting.id}/close`)
      .set('Cookie', authCookie());

    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/already submitted an inservice sheet for this time period/i);

    // Confirm the blocked session was left untouched — no partial credit.
    const saved = await db.collection('sessions').doc(conflicting.id).get();
    expect(saved.data().status).toBe('scheduled');
  });

  it('allows closing out a non-overlapping session for the same trainer on the same day', async () => {
    const existing = await db.collection('sessions').add({
      date: '2026-06-03',
      startTime: '09:00 AM',
      location: 'MCAC',
      length: 1,
      status: 'completed',
      topics: ['CPR'],
      trainer: ['trainer-no-overlap'],
      inserviceSheetKey: 'inservice-sheets/2026/06/already-submitted.docx',
    });
    createdSessionIds.push(existing.id);

    const laterSession = await db.collection('sessions').add({
      date: '2026-06-03',
      startTime: '11:00 AM', // starts exactly when the 9:00-10:00 session ends
      location: 'MCAC',
      length: 1,
      status: 'scheduled',
      topics: ['First Aid'],
      trainer: ['trainer-no-overlap'],
      trainees: [],
    });
    createdSessionIds.push(laterSession.id);

    const response = await request(app)
      .post(`/api/sessions/${laterSession.id}/close`)
      .set('Cookie', authCookie());

    expect(response.status).toBe(200);
  });
});
