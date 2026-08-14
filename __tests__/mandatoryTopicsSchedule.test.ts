export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');
const { getWeekOfMonth } = require('../services/mandatoryTopicsService');

// Runs against the local Firestore emulator (see jest.setup.js).
describe('Mandatory topics schedule', () => {
  const createdEmployeeIds: string[] = [];
  const createdMonthDocIds: string[] = [];

  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) await db.collection('employees').doc(id).delete();
    for (const id of createdMonthDocIds.splice(0)) await db.collection('mandatoryTopics').doc(id).delete();
  });

  async function makeActor(role: string) {
    const ref = await db.collection('employees').add({ name: 'Test Actor', role });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  describe('getWeekOfMonth (day-of-month bucketing)', () => {
    it('buckets day 7 into week 1 and day 8 into week 2', () => {
      expect(getWeekOfMonth('2026-08-07')).toBe(1);
      expect(getWeekOfMonth('2026-08-08')).toBe(2);
    });

    it('buckets day 28 into week 4 and day 29 into week 5', () => {
      expect(getWeekOfMonth('2026-08-28')).toBe(4);
      expect(getWeekOfMonth('2026-08-29')).toBe(5);
    });

    it('a 28-day February never reaches week 5', () => {
      expect(getWeekOfMonth('2026-02-28')).toBe(4);
    });
  });

  describe('GET /api/mandatory-topics/:yearMonth', () => {
    it('returns all-empty-array weeks when no month doc exists yet', async () => {
      const response = await request(app)
        .get('/api/mandatory-topics/2099-01')
        .set('Cookie', authCookie());

      expect(response.status).toBe(200);
      expect(response.body.weeks).toEqual({ '1': [], '2': [], '3': [], '4': [], '5': [] });
    });
  });

  describe('GET /api/mandatory-topics/for-date', () => {
    it('resolves a date to its week and that week\'s mandatory topics', async () => {
      createdMonthDocIds.push('2026-08');
      await db.collection('mandatoryTopics').doc('2026-08').set({
        weeks: { '1': ['CPR'], '2': ['First Aid'], '3': [], '4': [], '5': [] },
      });

      const response = await request(app)
        .get('/api/mandatory-topics/for-date')
        .query({ date: '2026-08-10' }) // day 10 -> week 2
        .set('Cookie', authCookie());

      expect(response.status).toBe(200);
      expect(response.body.week).toBe(2);
      expect(response.body.topics).toEqual(['First Aid']);
    });
  });

  describe('PUT /api/mandatory-topics/:yearMonth', () => {
    it('rejects a plain Supervisor — managing the schedule is Senior Supervisor and up only', async () => {
      const actorId = await makeActor('supervisor');

      const response = await request(app)
        .put('/api/mandatory-topics/2026-09')
        .set('Cookie', authCookie({ role: 'supervisor', employeeId: actorId }))
        .send({ weeks: { '1': ['CPR'] } });

      expect(response.status).toBe(403);
    });

    it('allows a Senior Supervisor, and persists the schedule', async () => {
      const actorId = await makeActor('seniorSupervisor');
      createdMonthDocIds.push('2026-09');

      const response = await request(app)
        .put('/api/mandatory-topics/2026-09')
        .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId: actorId }))
        .send({ weeks: { '1': ['CPR'], '3': ['EAP'] } });

      expect(response.status).toBe(200);

      const saved = await db.collection('mandatoryTopics').doc('2026-09').get();
      expect(saved.data().weeks).toEqual({ '1': ['CPR'], '2': [], '3': ['EAP'], '4': [], '5': [] });
      expect(saved.data().updatedByEmployeeId).toBe(actorId);
    });

    // Regression coverage for the same class of bug fixed in
    // manualHoursPermission.test.ts — the live Firestore value must win
    // over whatever the session JWT happened to claim at login.
    it('blocks immediately when demoted to Supervisor in Firestore, even if the stale session JWT still claims seniorSupervisor', async () => {
      const actorId = await makeActor('supervisor');

      const response = await request(app)
        .put('/api/mandatory-topics/2026-09')
        .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId: actorId }))
        .send({ weeks: { '1': ['CPR'] } });

      expect(response.status).toBe(403);
    });

    it('rejects an invalid week key', async () => {
      const actorId = await makeActor('seniorSupervisor');

      const response = await request(app)
        .put('/api/mandatory-topics/2026-09')
        .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId: actorId }))
        .send({ weeks: { '6': ['CPR'] } });

      expect(response.status).toBe(400);
    });
  });
});
