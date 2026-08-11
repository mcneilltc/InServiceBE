export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// Runs against the local Firestore emulator (see jest.setup.js).
// POST /api/training-sessions/:employeeId now stamps every session with
// who actually submitted it (from the verified session, not the request
// body), independent of the `trainer` field — used both to attribute a
// bulk-imported record to the supervisor who uploaded it, and generally as
// an audit trail for any session created through this endpoint.
describe('POST /api/training-sessions/:employeeId — createdBy attribution', () => {
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

  it('stamps createdBy from the authenticated session, not the request body', async () => {
    const employeeId = await makeEmployee();

    const response = await request(app)
      .post(`/api/training-sessions/${employeeId}`)
      .set('Cookie', authCookie({ name: 'Supervisor Sue', email: 'sue@example.com' }))
      .send({
        date: '2026-06-05',
        location: 'MCAC',
        length: 4,
        topics: ['Inservice Training'],
        trainer: 'Imported',
        trainees: [],
        // Attempting to spoof a different uploader — must be ignored.
        createdBy: { name: 'Not Sue', email: 'attacker@example.com' },
      });

    expect(response.status).toBe(201);
    expect(response.body.session.createdBy).toEqual({
      employeeId: null,
      name: 'Supervisor Sue',
      email: 'sue@example.com',
    });

    const saved = await db.collection('employees').doc(employeeId).collection('trainingSessions').doc(response.body.sessionId).get();
    expect(saved.data().createdBy.name).toBe('Supervisor Sue');
    // trainer stays untouched — createdBy is separate metadata, not a
    // replacement for it (the incentive exclusion still keys off this).
    expect(saved.data().trainer).toBe('Imported');
  });
});
