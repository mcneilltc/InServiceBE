export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// POST /api/training-sessions/:employeeId is the single endpoint behind both
// the Manage Employees "Add Hours" dialog and the Excel import's historical-
// hours step. A supervisor's employees.canAddManualHours flag (see
// authService.resolveRole) gates it — only an explicit `false` blocks; a
// missing/undefined flag (existing supervisors, all trainers) stays allowed.
describe('POST /api/training-sessions/:employeeId — manual-hours permission gate', () => {
  const createdEmployeeIds: string[] = [];

  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) {
      const sessionsSnap = await db.collection('employees').doc(id).collection('trainingSessions').get();
      for (const doc of sessionsSnap.docs) await doc.ref.delete();
      await db.collection('employees').doc(id).delete();
    }
  });

  async function makeEmployee() {
    const ref = await db.collection('employees').add({ name: 'Test Lifeguard', homeLocation: 'MCAC' });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  function sessionPayload() {
    return {
      date: '2026-06-05',
      location: 'MCAC',
      length: 4,
      topics: ['Inservice Training'],
      trainer: 'Manual Entry',
      trainees: [],
    };
  }

  it('rejects a supervisor whose canAddManualHours flag has been explicitly revoked', async () => {
    const employeeId = await makeEmployee();

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      .set('Cookie', authCookie({ canAddManualHours: false }))
      .send(sessionPayload());

    expect(response.status).toBe(403);

    const sessionsSnap = await db.collection('employees').doc(employeeId).collection('trainingSessions').get();
    expect(sessionsSnap.empty).toBe(true);
  });

  it('allows a supervisor whose canAddManualHours flag is explicitly true', async () => {
    const employeeId = await makeEmployee();

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      .set('Cookie', authCookie({ canAddManualHours: true }))
      .send(sessionPayload());

    expect(response.status).toBe(201);
  });

  it('allows a supervisor with no canAddManualHours claim at all (pre-existing sessions)', async () => {
    const employeeId = await makeEmployee();

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      .set('Cookie', authCookie())
      .send(sessionPayload());

    expect(response.status).toBe(201);
  });

  it('allows a trainer regardless of the (supervisor-only) flag', async () => {
    const employeeId = await makeEmployee();

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      .set('Cookie', authCookie({ role: 'trainer', supervisorScope: null }))
      .send(sessionPayload());

    expect(response.status).toBe(201);
  });
});
