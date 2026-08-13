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
