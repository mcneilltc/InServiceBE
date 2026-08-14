export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// POST /api/training-sessions/:employeeId is the single endpoint behind both
// the Manage Employees "Add Hours" dialog and the Excel import's historical-
// hours step. Manual-hours-adding is bundled into Senior Supervisor and up
// (see utils/roles.ts) — a plain Supervisor never has it, no matter what.
//
// The gate is checked LIVE against the actor's own Firestore employee
// record, not the role claim baked into their session JWT — that claim is
// only as fresh as their last login or requireRole's sliding mid-session
// refresh (which re-signs the *same* claims), so a promotion/demotion must
// take effect immediately, not after the actor's session happens to expire.
// See trainingSessionsController.ts.
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

  async function makeActor(role: string) {
    const ref = await db.collection('employees').add({ name: 'Test Actor', role });
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

  it('rejects a plain Supervisor — this was never toggleable, only Senior Supervisor and up have it', async () => {
    const employeeId = await makeEmployee();
    const actorId = await makeActor('supervisor');

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      .set('Cookie', authCookie({ role: 'supervisor', employeeId: actorId }))
      .send(sessionPayload());

    expect(response.status).toBe(403);

    const sessionsSnap = await db.collection('employees').doc(employeeId).collection('trainingSessions').get();
    expect(sessionsSnap.empty).toBe(true);
  });

  it('allows a Senior Supervisor', async () => {
    const employeeId = await makeEmployee();
    const actorId = await makeActor('seniorSupervisor');

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId: actorId }))
      .send(sessionPayload());

    expect(response.status).toBe(201);
  });

  it('allows an Admin', async () => {
    const employeeId = await makeEmployee();
    const actorId = await makeActor('admin');

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      .set('Cookie', authCookie({ role: 'admin', employeeId: actorId }))
      .send(sessionPayload());

    expect(response.status).toBe(201);
  });

  it('allows a trainer regardless of tier, with no Firestore lookup needed — this was never gated for them', async () => {
    const employeeId = await makeEmployee();

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      .set('Cookie', authCookie({ role: 'trainer', employeeId: 'nonexistent-trainer-id' }))
      .send(sessionPayload());

    expect(response.status).toBe(201);
  });

  // These two are the actual regression tests for the bug: an actor's
  // session JWT can carry a role claim that no longer matches Firestore (an
  // admin changed it after they logged in). The live Firestore value must
  // win in both directions — a demotion blocks immediately, and a promotion
  // un-blocks immediately — without the actor needing to log out and back in.
  it('blocks immediately when demoted to Supervisor in Firestore, even if the stale session JWT still claims seniorSupervisor', async () => {
    const employeeId = await makeEmployee();
    const actorId = await makeActor('supervisor');

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      // Simulates a session issued before the admin demoted this actor.
      .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId: actorId }))
      .send(sessionPayload());

    expect(response.status).toBe(403);
  });

  it('allows immediately when promoted to Senior Supervisor in Firestore, even if the stale session JWT still claims supervisor', async () => {
    const employeeId = await makeEmployee();
    const actorId = await makeActor('seniorSupervisor');

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      // Simulates a session issued before the admin promoted this actor.
      .set('Cookie', authCookie({ role: 'supervisor', employeeId: actorId }))
      .send(sessionPayload());

    expect(response.status).toBe(201);
  });
});
