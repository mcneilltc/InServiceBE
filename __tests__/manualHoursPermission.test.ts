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
//
// The gate is checked LIVE against the supervisor's own Firestore employee
// record, not the canAddManualHours claim baked into their session JWT —
// that claim is only as fresh as their last login or requireRole's sliding
// mid-session refresh (which re-signs the *same* claims), so an admin
// revoking/re-granting this must take effect immediately, not after the
// supervisor's session happens to expire. See trainingSessionsController.ts.
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

  async function makeSupervisor(overrides: Record<string, any> = {}) {
    const ref = await db.collection('employees').add({
      name: 'Test Supervisor',
      isSupervisor: true,
      ...overrides,
    });
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

  it('rejects a supervisor whose Firestore record has canAddManualHours explicitly revoked', async () => {
    const employeeId = await makeEmployee();
    const supervisorId = await makeSupervisor({ canAddManualHours: false });

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      .set('Cookie', authCookie({ employeeId: supervisorId }))
      .send(sessionPayload());

    expect(response.status).toBe(403);

    const sessionsSnap = await db.collection('employees').doc(employeeId).collection('trainingSessions').get();
    expect(sessionsSnap.empty).toBe(true);
  });

  it('allows a supervisor whose Firestore record has canAddManualHours explicitly true', async () => {
    const employeeId = await makeEmployee();
    const supervisorId = await makeSupervisor({ canAddManualHours: true });

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      .set('Cookie', authCookie({ employeeId: supervisorId }))
      .send(sessionPayload());

    expect(response.status).toBe(201);
  });

  it('allows a supervisor with no canAddManualHours field at all (pre-existing supervisors)', async () => {
    const employeeId = await makeEmployee();
    const supervisorId = await makeSupervisor();

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      .set('Cookie', authCookie({ employeeId: supervisorId }))
      .send(sessionPayload());

    expect(response.status).toBe(201);
  });

  it('allows a trainer regardless of the (supervisor-only) flag, with no Firestore lookup needed', async () => {
    const employeeId = await makeEmployee();

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      .set('Cookie', authCookie({ role: 'trainer', supervisorScope: null, employeeId: 'nonexistent-trainer-id' }))
      .send(sessionPayload());

    expect(response.status).toBe(201);
  });

  // These two are the actual regression tests for the bug: a supervisor's
  // session JWT can carry a canAddManualHours claim that no longer matches
  // Firestore (an admin changed it after they logged in). The live
  // Firestore value must win in both directions — revoking mid-session
  // blocks immediately, and re-granting mid-session un-blocks immediately —
  // without the supervisor needing to log out and back in.
  it('blocks immediately when revoked in Firestore, even if the stale session JWT still claims true', async () => {
    const employeeId = await makeEmployee();
    const supervisorId = await makeSupervisor({ canAddManualHours: false });

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      // Simulates a session issued before the admin revoked access.
      .set('Cookie', authCookie({ employeeId: supervisorId, canAddManualHours: true }))
      .send(sessionPayload());

    expect(response.status).toBe(403);
  });

  it('allows immediately when re-granted in Firestore, even if the stale session JWT still claims false', async () => {
    const employeeId = await makeEmployee();
    const supervisorId = await makeSupervisor({ canAddManualHours: true });

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      // Simulates a session issued before the admin re-granted access.
      .set('Cookie', authCookie({ employeeId: supervisorId, canAddManualHours: false }))
      .send(sessionPayload());

    expect(response.status).toBe(201);
  });
});
