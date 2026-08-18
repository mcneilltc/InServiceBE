export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const moment = require('moment');
const { authCookie } = require('./testHelpers');

// Covers the "early checkout" flow end to end: recording/clearing a
// per-employee checkout time (routes/checkin.ts), and performCloseOut
// (sessionCloseOutService.ts) crediting each person min(their checkout,
// session close-out) − their check-in instead of everyone sharing the
// session's close-out time.
describe('Early checkout', () => {
  const createdEmployeeIds: string[] = [];
  const createdSessionIds: string[] = [];
  const createdCheckinIds: string[] = [];

  afterEach(async () => {
    for (const id of createdCheckinIds.splice(0)) await db.collection('checkins').doc(id).delete();
    for (const id of createdSessionIds.splice(0)) await db.collection('sessions').doc(id).delete();
    for (const id of createdEmployeeIds.splice(0)) {
      const sessionsSnap = await db.collection('employees').doc(id).collection('trainingSessions').get();
      for (const doc of sessionsSnap.docs) await doc.ref.delete();
      await db.collection('employees').doc(id).delete();
    }
  });

  async function makeEmployee(overrides: Record<string, any> = {}) {
    const ref = await db.collection('employees').add({ name: 'Test Lifeguard', homeLocation: 'MCAC', totalHours: 0, ...overrides });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  async function makeSession(overrides: Record<string, any> = {}) {
    const ref = await db.collection('sessions').add({
      date: moment().format('YYYY-MM-DD'),
      location: 'MCAC',
      status: 'scheduled',
      topics: ['CPR'],
      trainer: ['trainer-1'],
      trainees: [],
      ...overrides,
    });
    createdSessionIds.push(ref.id);
    return ref.id;
  }

  async function makeCheckin(sessionId: string, employeeId: string, checkinTime: string) {
    const ref = await db.collection('checkins').add({ sessionId, employeeId, name: 'Test Lifeguard', location: 'MCAC', checkinTime });
    createdCheckinIds.push(ref.id);
    return ref.id;
  }

  describe('GET /api/checkin/session/:sessionId', () => {
    it('returns only checkins for that session, oldest first', async () => {
      const sessionId = await makeSession();
      const otherSessionId = await makeSession();
      const employeeId = await makeEmployee();
      const otherEmployeeId = await makeEmployee();
      const later = moment().toISOString();
      const earlier = moment().subtract(10, 'minutes').toISOString();
      await makeCheckin(sessionId, employeeId, later);
      await makeCheckin(sessionId, otherEmployeeId, earlier);
      await makeCheckin(otherSessionId, employeeId, later);

      const response = await request(app)
        .get(`/api/checkin/session/${sessionId}`)
        .set('Cookie', authCookie({ role: 'trainer' }));

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(response.body[0].checkinTime).toBe(earlier);
      expect(response.body[1].checkinTime).toBe(later);
    });
  });

  describe('POST /api/checkin/:checkinId/checkout', () => {
    it('defaults to now when no checkoutTime is given', async () => {
      const sessionId = await makeSession();
      const employeeId = await makeEmployee();
      const checkinId = await makeCheckin(sessionId, employeeId, moment().subtract(20, 'minutes').toISOString());

      const before = Date.now();
      const response = await request(app)
        .post(`/api/checkin/${checkinId}/checkout`)
        .set('Cookie', authCookie({ role: 'trainer' }))
        .send({});

      expect(response.status).toBe(200);
      const checkoutMs = new Date(response.body.checkoutTime).getTime();
      expect(checkoutMs).toBeGreaterThanOrEqual(before);
      expect(checkoutMs).toBeLessThanOrEqual(Date.now());
    });

    it('accepts an explicit checkoutTime', async () => {
      const sessionId = await makeSession();
      const employeeId = await makeEmployee();
      const checkinTime = moment().subtract(30, 'minutes').toISOString();
      const checkoutTime = moment().subtract(5, 'minutes').toISOString();
      const checkinId = await makeCheckin(sessionId, employeeId, checkinTime);

      const response = await request(app)
        .post(`/api/checkin/${checkinId}/checkout`)
        .set('Cookie', authCookie({ role: 'trainer' }))
        .send({ checkoutTime });

      expect(response.status).toBe(200);
      const saved = await db.collection('checkins').doc(checkinId).get();
      expect(saved.data()?.checkoutTime).toBe(checkoutTime);
    });

    it('clears an existing checkout when checkoutTime is explicitly null', async () => {
      const sessionId = await makeSession();
      const employeeId = await makeEmployee();
      const checkinId = await makeCheckin(sessionId, employeeId, moment().subtract(30, 'minutes').toISOString());
      await db.collection('checkins').doc(checkinId).update({ checkoutTime: moment().subtract(5, 'minutes').toISOString() });

      const response = await request(app)
        .post(`/api/checkin/${checkinId}/checkout`)
        .set('Cookie', authCookie({ role: 'trainer' }))
        .send({ checkoutTime: null });

      expect(response.status).toBe(200);
      const saved = await db.collection('checkins').doc(checkinId).get();
      expect(saved.data()?.checkoutTime).toBeUndefined();
    });

    it('rejects a checkout time before the check-in time', async () => {
      const sessionId = await makeSession();
      const employeeId = await makeEmployee();
      const checkinTime = moment().subtract(10, 'minutes').toISOString();
      const checkinId = await makeCheckin(sessionId, employeeId, checkinTime);

      const response = await request(app)
        .post(`/api/checkin/${checkinId}/checkout`)
        .set('Cookie', authCookie({ role: 'trainer' }))
        .send({ checkoutTime: moment().subtract(20, 'minutes').toISOString() });

      expect(response.status).toBe(400);
    });

    it('404s for a checkin that does not exist', async () => {
      const response = await request(app)
        .post('/api/checkin/does-not-exist/checkout')
        .set('Cookie', authCookie({ role: 'trainer' }))
        .send({});
      expect(response.status).toBe(404);
    });

    it('rejects recording a checkout once the session has already been closed out', async () => {
      const sessionId = await makeSession({ status: 'completed' });
      const employeeId = await makeEmployee();
      const checkinId = await makeCheckin(sessionId, employeeId, moment().subtract(30, 'minutes').toISOString());

      const response = await request(app)
        .post(`/api/checkin/${checkinId}/checkout`)
        .set('Cookie', authCookie({ role: 'trainer' }))
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/already been closed out/i);
    });
  });

  describe('performCloseOut crediting with an early checkout', () => {
    it('credits an employee who left early only up to their checkout time, not the full session', async () => {
      const checkinTime = moment().subtract(2, 'hours');
      const checkoutTime = moment().subtract(1, 'hours'); // left 1 hour in
      const sessionId = await makeSession({ trainer: [] });
      const employeeId = await makeEmployee();
      await makeCheckin(sessionId, employeeId, checkinTime.toISOString());
      await db.collection('checkins')
        .where('sessionId', '==', sessionId)
        .where('employeeId', '==', employeeId)
        .get()
        .then((snap: any) => snap.docs[0].ref.update({ checkoutTime: checkoutTime.toISOString() }));

      const response = await request(app)
        .post(`/api/sessions/${sessionId}/close`)
        .set('Cookie', authCookie({ role: 'trainer' }));

      expect(response.status).toBe(200);
      const sessionsSnap = await db.collection('employees').doc(employeeId).collection('trainingSessions').get();
      expect(sessionsSnap.docs).toHaveLength(1);
      const credited = sessionsSnap.docs[0].data();
      // ~1 hour (checkin -> checkout), not ~2 hours (checkin -> real close-out "now").
      expect(credited.length).toBeCloseTo(1, 1);
      expect(credited.checkedOutAt).toBe(checkoutTime.toISOString());
    });

    it('credits the full elapsed time for an employee with no checkout time', async () => {
      const checkinTime = moment().subtract(1, 'hours');
      const sessionId = await makeSession({ trainer: [] });
      const employeeId = await makeEmployee();
      await makeCheckin(sessionId, employeeId, checkinTime.toISOString());

      const response = await request(app)
        .post(`/api/sessions/${sessionId}/close`)
        .set('Cookie', authCookie({ role: 'trainer' }));

      expect(response.status).toBe(200);
      const sessionsSnap = await db.collection('employees').doc(employeeId).collection('trainingSessions').get();
      const credited = sessionsSnap.docs[0].data();
      expect(credited.length).toBeCloseTo(1, 1);
      expect(credited.checkedOutAt).toBeUndefined();
    });

    it('ignores a checkout time that is somehow after the real close-out (defensive min())', async () => {
      const checkinTime = moment().subtract(1, 'hours');
      const futureCheckout = moment().add(1, 'hours'); // shouldn't be possible, but guard anyway
      const sessionId = await makeSession({ trainer: [] });
      const employeeId = await makeEmployee();
      await makeCheckin(sessionId, employeeId, checkinTime.toISOString());
      await db.collection('checkins')
        .where('sessionId', '==', sessionId)
        .where('employeeId', '==', employeeId)
        .get()
        .then((snap: any) => snap.docs[0].ref.update({ checkoutTime: futureCheckout.toISOString() }));

      const response = await request(app)
        .post(`/api/sessions/${sessionId}/close`)
        .set('Cookie', authCookie({ role: 'trainer' }));

      expect(response.status).toBe(200);
      const sessionsSnap = await db.collection('employees').doc(employeeId).collection('trainingSessions').get();
      const credited = sessionsSnap.docs[0].data();
      // Credited up to the real close-out (~1 hour), not the bogus future checkout (~2 hours).
      expect(credited.length).toBeCloseTo(1, 1);
    });
  });
});
