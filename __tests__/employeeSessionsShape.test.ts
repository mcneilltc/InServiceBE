export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');

// GET /api/training-sessions/employee/:employeeId backs the legacy
// employee-hours calendar page (src/pages/employee-hours/[employeeId].js),
// which computes total/duration figures from `length` — these per-employee
// credited records only ever store a duration (see performCloseOut in
// sessionCloseOutService.ts), never a startTime/endTime. The endpoint used
// to omit `length` (and `location`) entirely, which was silently producing
// "Invalid Date" math on that page. Confirms both are now included.
describe('GET /api/training-sessions/employee/:employeeId — response shape', () => {
  let employeeId: string;

  beforeEach(async () => {
    const ref = await db.collection('employees').add({ name: 'Shape Test Employee' });
    employeeId = ref.id;
    await db.collection('employees').doc(employeeId).collection('trainingSessions').add({
      date: '2026-08-17',
      location: 'ERRC',
      topics: ['CPR'],
      trainer: ['trainer-1'],
      length: 1.93,
      status: 'completed',
    });
  });

  afterEach(async () => {
    const sessionsSnap = await db.collection('employees').doc(employeeId).collection('trainingSessions').get();
    for (const doc of sessionsSnap.docs) await doc.ref.delete();
    await db.collection('employees').doc(employeeId).delete();
  });

  it('includes length and location on each credited session', async () => {
    const response = await request(app).get(`/api/training-sessions/employee/${employeeId}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].length).toBe(1.93);
    expect(response.body[0].location).toBe('ERRC');
    expect(response.body[0]).not.toHaveProperty('startTime');
    expect(response.body[0]).not.toHaveProperty('endTime');
  });
});
