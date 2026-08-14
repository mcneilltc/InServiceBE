export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// Runs against the local Firestore emulator (see jest.setup.js). Covers the
// actual enforcement boundary at session creation — see
// mandatoryTopicsSchedule.test.ts for the schedule-management endpoints
// themselves.
describe('POST /api/sessions — mandatory topics enforcement', () => {
  const createdSessionIds: string[] = [];
  const createdMonthDocIds: string[] = [];

  afterEach(async () => {
    for (const id of createdSessionIds.splice(0)) await db.collection('sessions').doc(id).delete();
    for (const id of createdMonthDocIds.splice(0)) await db.collection('mandatoryTopics').doc(id).delete();
  });

  function sessionPayload(overrides: Record<string, any> = {}) {
    return {
      date: '2026-10-10', // day 10 -> week 2
      location: 'MCAC',
      length: 60,
      topics: ['Some Topic'],
      trainer: 'trainer-1',
      trainees: [],
      ...overrides,
    };
  }

  it('rejects a session missing a mandatory topic for that date\'s week', async () => {
    createdMonthDocIds.push('2026-10');
    await db.collection('mandatoryTopics').doc('2026-10').set({
      weeks: { '1': [], '2': ['CPR'], '3': [], '4': [], '5': [] },
    });

    const response = await request(app)
      .post('/api/sessions')
      .set('Cookie', authCookie())
      .send(sessionPayload({ topics: ['Something Else'] }));

    expect(response.status).toBe(400);
    expect(response.body.error.missingMandatoryTopics).toEqual(['CPR']);
  });

  it('allows the session when the mandatory topic is included, alongside additional topics', async () => {
    createdMonthDocIds.push('2026-10');
    await db.collection('mandatoryTopics').doc('2026-10').set({
      weeks: { '1': [], '2': ['CPR'], '3': [], '4': [], '5': [] },
    });

    const response = await request(app)
      .post('/api/sessions')
      .set('Cookie', authCookie())
      .send(sessionPayload({ topics: ['CPR', 'Something Else'] }));

    expect(response.status).toBe(201);
    createdSessionIds.push(response.body.sessionId);
  });

  it('behaves exactly as before when no schedule is configured for that month', async () => {
    // No mandatoryTopics doc created for this month at all.
    const response = await request(app)
      .post('/api/sessions')
      .set('Cookie', authCookie())
      .send(sessionPayload({ date: '2027-03-05', topics: ['Whatever The Trainer Picked'] }));

    expect(response.status).toBe(201);
    createdSessionIds.push(response.body.sessionId);
  });

  it('only requires the topic mandatory for that specific week, not other weeks in the same month', async () => {
    createdMonthDocIds.push('2026-10');
    await db.collection('mandatoryTopics').doc('2026-10').set({
      // Week 1 requires CPR, but our session is in week 2 (day 10).
      weeks: { '1': ['CPR'], '2': [], '3': [], '4': [], '5': [] },
    });

    const response = await request(app)
      .post('/api/sessions')
      .set('Cookie', authCookie())
      .send(sessionPayload({ topics: ['Unrelated Topic'] }));

    expect(response.status).toBe(201);
    createdSessionIds.push(response.body.sessionId);
  });
});

describe('PUT /api/sessions/:sessionId — mandatory topics enforcement on edit', () => {
  const createdSessionIds: string[] = [];
  const createdMonthDocIds: string[] = [];

  afterEach(async () => {
    for (const id of createdSessionIds.splice(0)) await db.collection('sessions').doc(id).delete();
    for (const id of createdMonthDocIds.splice(0)) await db.collection('mandatoryTopics').doc(id).delete();
  });

  async function makeSession(overrides: Record<string, any> = {}) {
    const ref = await db.collection('sessions').add({
      date: '2026-10-10', // day 10 -> week 2
      location: 'MCAC',
      status: 'scheduled',
      topics: ['CPR', 'Something Else'],
      trainer: ['trainer-1'],
      trainees: [],
      ...overrides,
    });
    createdSessionIds.push(ref.id);
    return ref.id;
  }

  it('rejects removing a mandatory topic for that session\'s week', async () => {
    createdMonthDocIds.push('2026-10');
    await db.collection('mandatoryTopics').doc('2026-10').set({
      weeks: { '1': [], '2': ['CPR'], '3': [], '4': [], '5': [] },
    });
    const sessionId = await makeSession();

    const response = await request(app)
      .put(`/api/sessions/${sessionId}`)
      .set('Cookie', authCookie())
      .send({ topics: ['Something Else'] });

    expect(response.status).toBe(400);
    expect(response.body.error.missingMandatoryTopics).toEqual(['CPR']);

    const saved = await db.collection('sessions').doc(sessionId).get();
    expect(saved.data()?.topics).toEqual(['CPR', 'Something Else']);
  });

  it('allows editing non-mandatory topics as long as the mandatory one stays included', async () => {
    createdMonthDocIds.push('2026-10');
    await db.collection('mandatoryTopics').doc('2026-10').set({
      weeks: { '1': [], '2': ['CPR'], '3': [], '4': [], '5': [] },
    });
    const sessionId = await makeSession();

    const response = await request(app)
      .put(`/api/sessions/${sessionId}`)
      .set('Cookie', authCookie())
      .send({ topics: ['CPR', 'A New Topic'] });

    expect(response.status).toBe(200);
    const saved = await db.collection('sessions').doc(sessionId).get();
    expect(saved.data()?.topics).toEqual(['CPR', 'A New Topic']);
  });

  it('rejects editing topics on a session that has already been closed out', async () => {
    const sessionId = await makeSession({ status: 'completed' });

    const response = await request(app)
      .put(`/api/sessions/${sessionId}`)
      .set('Cookie', authCookie())
      .send({ topics: ['Something Else'] });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/already been closed out/i);
  });

  it('leaves topics enforcement out of updates that don\'t touch topics', async () => {
    createdMonthDocIds.push('2026-10');
    await db.collection('mandatoryTopics').doc('2026-10').set({
      weeks: { '1': [], '2': ['CPR'], '3': [], '4': [], '5': [] },
    });
    const sessionId = await makeSession();

    const response = await request(app)
      .put(`/api/sessions/${sessionId}`)
      .set('Cookie', authCookie())
      .send({ trainees: ['employee-1'] });

    expect(response.status).toBe(200);
  });
});
