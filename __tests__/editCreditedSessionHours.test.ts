export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// PATCH /api/training-sessions/:employeeId/:sessionDocId — corrects an
// already-credited session's hours (e.g. an employee left before close-out
// and got over-credited by performCloseOut's checkin-to-close-out math).
// Same permission tier as manually adding hours (see manualHoursPermission.test.ts).
describe('PATCH /api/training-sessions/:employeeId/:sessionDocId', () => {
  const createdEmployeeIds: string[] = [];

  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) {
      const sessionsSnap = await db.collection('employees').doc(id).collection('trainingSessions').get();
      for (const doc of sessionsSnap.docs) await doc.ref.delete();
      await db.collection('employees').doc(id).delete();
    }
  });

  async function makeEmployee(overrides: Record<string, any> = {}) {
    const ref = await db.collection('employees').add({ name: 'Test Lifeguard', homeLocation: 'MCAC', totalHours: 5, ...overrides });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  async function makeActor(role: string) {
    const ref = await db.collection('employees').add({ name: 'Test Actor', role });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  async function makeCreditedSession(employeeId: string, overrides: Record<string, any> = {}) {
    const ref = await db.collection('employees').doc(employeeId).collection('trainingSessions').add({
      date: '2026-08-17',
      location: 'ERRC',
      topics: ['CPR'],
      trainer: ['trainer-1'],
      length: 1.93,
      status: 'completed',
      sourceSessionId: 'session-x',
      ...overrides,
    });
    return ref.id;
  }

  it('reduces the credited hours and decrements totalHours by the delta', async () => {
    const employeeId = await makeEmployee({ totalHours: 10 });
    const sessionDocId = await makeCreditedSession(employeeId, { length: 1.93 });
    const actorId = await makeActor('seniorSupervisor');

    const response = await request(app)
      .patch(`/api/training-sessions/${employeeId}/${sessionDocId}`)
      .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId: actorId }))
      .send({ length: 0.5 });

    expect(response.status).toBe(200);
    expect(response.body.length).toBe(0.5);
    expect(response.body.previousLength).toBe(1.93);

    const sessionDoc = await db.collection('employees').doc(employeeId).collection('trainingSessions').doc(sessionDocId).get();
    expect(sessionDoc.data()?.length).toBe(0.5);
    expect(sessionDoc.data()?.previousLength).toBe(1.93);
    expect(sessionDoc.data()?.editedBy).toBeTruthy();

    const employeeDoc = await db.collection('employees').doc(employeeId).get();
    // 10 - (1.93 - 0.5) = 8.57
    expect(employeeDoc.data()?.totalHours).toBeCloseTo(8.57, 5);
  });

  it('increases the credited hours and increments totalHours by the delta', async () => {
    const employeeId = await makeEmployee({ totalHours: 10 });
    const sessionDocId = await makeCreditedSession(employeeId, { length: 1 });
    const actorId = await makeActor('admin');

    const response = await request(app)
      .patch(`/api/training-sessions/${employeeId}/${sessionDocId}`)
      .set('Cookie', authCookie({ role: 'admin', employeeId: actorId }))
      .send({ length: 2 });

    expect(response.status).toBe(200);
    const employeeDoc = await db.collection('employees').doc(employeeId).get();
    expect(employeeDoc.data()?.totalHours).toBeCloseTo(11, 5);
  });

  it('rejects a plain Supervisor — this is Senior Supervisor and up only', async () => {
    const employeeId = await makeEmployee();
    const sessionDocId = await makeCreditedSession(employeeId);
    const actorId = await makeActor('supervisor');

    const response = await request(app)
      .patch(`/api/training-sessions/${employeeId}/${sessionDocId}`)
      .set('Cookie', authCookie({ role: 'supervisor', employeeId: actorId }))
      .send({ length: 0.5 });

    expect(response.status).toBe(403);
    const sessionDoc = await db.collection('employees').doc(employeeId).collection('trainingSessions').doc(sessionDocId).get();
    expect(sessionDoc.data()?.length).toBe(1.93);
  });

  it('allows a trainer regardless of tier — this was never gated for them', async () => {
    const employeeId = await makeEmployee();
    const sessionDocId = await makeCreditedSession(employeeId);

    const response = await request(app)
      .patch(`/api/training-sessions/${employeeId}/${sessionDocId}`)
      .set('Cookie', authCookie({ role: 'trainer', employeeId: 'nonexistent-trainer-id' }))
      .send({ length: 0.5 });

    expect(response.status).toBe(200);
  });

  it('404s for a session doc that does not exist', async () => {
    const employeeId = await makeEmployee();
    const actorId = await makeActor('admin');

    const response = await request(app)
      .patch(`/api/training-sessions/${employeeId}/does-not-exist`)
      .set('Cookie', authCookie({ role: 'admin', employeeId: actorId }))
      .send({ length: 0.5 });

    expect(response.status).toBe(404);
  });

  it('400s for a negative length', async () => {
    const employeeId = await makeEmployee();
    const sessionDocId = await makeCreditedSession(employeeId);
    const actorId = await makeActor('admin');

    const response = await request(app)
      .patch(`/api/training-sessions/${employeeId}/${sessionDocId}`)
      .set('Cookie', authCookie({ role: 'admin', employeeId: actorId }))
      .send({ length: -1 });

    expect(response.status).toBe(400);
  });

  it('does not touch totalHours when the length is unchanged', async () => {
    const employeeId = await makeEmployee({ totalHours: 10 });
    const sessionDocId = await makeCreditedSession(employeeId, { length: 1.93 });
    const actorId = await makeActor('admin');

    const response = await request(app)
      .patch(`/api/training-sessions/${employeeId}/${sessionDocId}`)
      .set('Cookie', authCookie({ role: 'admin', employeeId: actorId }))
      .send({ length: 1.93 });

    expect(response.status).toBe(200);
    const employeeDoc = await db.collection('employees').doc(employeeId).get();
    expect(employeeDoc.data()?.totalHours).toBe(10);
  });
});
