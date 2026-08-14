export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// Runs against the local Firestore emulator (see jest.setup.js).
describe('GET /api/topic-tally', () => {
  const createdEmployeeIds: string[] = [];

  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) {
      const [sessionsSnap, ledSnap] = await Promise.all([
        db.collection('employees').doc(id).collection('trainingSessions').get(),
        db.collection('employees').doc(id).collection('trainingSessionsLed').get(),
      ]);
      await Promise.all([...sessionsSnap.docs, ...ledSnap.docs].map((d: any) => d.ref.delete()));
      await db.collection('employees').doc(id).delete();
    }
  });

  async function makeEmployee(overrides: Record<string, any> = {}) {
    const ref = await db.collection('employees').add({
      name: 'Test Employee',
      homeLocation: 'MCAC',
      locations: ['MCAC'],
      isActive: true,
      ...overrides,
    });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  async function addSession(employeeId: string, subcollection: string, date: string, topics: string[]) {
    await db.collection('employees').doc(employeeId).collection(subcollection).add({
      date, topics, length: 1,
    });
  }

  describe('GET /api/topic-tally/employees', () => {
    it('tallies a topic appearing in two sessions within the month to 2', async () => {
      const empId = await makeEmployee({ name: 'Alex Rivera' });
      await addSession(empId, 'trainingSessions', '2026-08-05', ['CPR']);
      await addSession(empId, 'trainingSessions', '2026-08-20', ['CPR', 'First Aid']);

      const response = await request(app)
        .get('/api/topic-tally/employees')
        .query({ period: 'month', month: '2026-08' })
        .set('Cookie', authCookie());

      expect(response.status).toBe(200);
      const row = response.body.rows.find((r: any) => r.id === empId);
      expect(row.counts.CPR).toBe(2);
      expect(row.counts['First Aid']).toBe(1);
      expect(row.total).toBe(3);
      expect(response.body.topics).toEqual(expect.arrayContaining(['CPR', 'First Aid']));
    });

    it('does not leak a session from the last day of the month into the next month', async () => {
      const empId = await makeEmployee({ name: 'Month Boundary Test' });
      await addSession(empId, 'trainingSessions', '2026-08-31', ['CPR']);

      const augustResponse = await request(app)
        .get('/api/topic-tally/employees')
        .query({ period: 'month', month: '2026-08' })
        .set('Cookie', authCookie());
      const septemberResponse = await request(app)
        .get('/api/topic-tally/employees')
        .query({ period: 'month', month: '2026-09' })
        .set('Cookie', authCookie());

      expect(augustResponse.body.rows.find((r: any) => r.id === empId).counts.CPR).toBe(1);
      expect(septemberResponse.body.rows.find((r: any) => r.id === empId)).toBeUndefined();
    });

    it('aggregates across the whole year in year mode', async () => {
      const empId = await makeEmployee({ name: 'Year Mode Test' });
      await addSession(empId, 'trainingSessions', '2026-02-01', ['EAP']);
      await addSession(empId, 'trainingSessions', '2026-11-15', ['EAP']);

      const response = await request(app)
        .get('/api/topic-tally/employees')
        .query({ period: 'year', year: '2026' })
        .set('Cookie', authCookie());

      const row = response.body.rows.find((r: any) => r.id === empId);
      expect(row.counts.EAP).toBe(2);
    });

    it('excludes a person with zero sessions in the selected range', async () => {
      const empId = await makeEmployee({ name: 'No Sessions This Month' });
      await addSession(empId, 'trainingSessions', '2025-01-01', ['CPR']); // outside range

      const response = await request(app)
        .get('/api/topic-tally/employees')
        .query({ period: 'month', month: '2026-08' })
        .set('Cookie', authCookie());

      expect(response.body.rows.find((r: any) => r.id === empId)).toBeUndefined();
    });

    it('scopes results to a location-scoped supervisor\'s own sites', async () => {
      const inScope = await makeEmployee({ name: 'In Scope', homeLocation: 'MCAC' });
      const outOfScope = await makeEmployee({ name: 'Out Of Scope', homeLocation: 'ERRC' });
      await addSession(inScope, 'trainingSessions', '2026-08-05', ['CPR']);
      await addSession(outOfScope, 'trainingSessions', '2026-08-05', ['CPR']);

      const response = await request(app)
        .get('/api/topic-tally/employees')
        .query({ period: 'month', month: '2026-08' })
        .set('Cookie', authCookie({ role: 'supervisor', supervisorLocations: ['MCAC'] }));

      const ids = response.body.rows.map((r: any) => r.id);
      expect(ids).toContain(inScope);
      expect(ids).not.toContain(outOfScope);
    });
  });

  describe('GET /api/topic-tally/trainers', () => {
    it('reads trainingSessionsLed independent of role', async () => {
      // A roster-only employee (no role at all) who happened to lead a
      // session — trainingSessionsLed is what matters, not the role field.
      const empId = await makeEmployee({ name: 'Led A Session', role: null });
      await addSession(empId, 'trainingSessionsLed', '2026-08-10', ['CPR', 'CPR']); // two topics entries in one session's array both count

      const response = await request(app)
        .get('/api/topic-tally/trainers')
        .query({ period: 'month', month: '2026-08' })
        .set('Cookie', authCookie());

      const row = response.body.rows.find((r: any) => r.id === empId);
      expect(row).toBeDefined();
      expect(row.counts.CPR).toBe(2);
    });

    it('does not pull from trainingSessions (employee-side) into the trainer tally', async () => {
      const empId = await makeEmployee({ name: 'Employee Side Only' });
      await addSession(empId, 'trainingSessions', '2026-08-05', ['CPR']);

      const response = await request(app)
        .get('/api/topic-tally/trainers')
        .query({ period: 'month', month: '2026-08' })
        .set('Cookie', authCookie());

      expect(response.body.rows.find((r: any) => r.id === empId)).toBeUndefined();
    });
  });
});
