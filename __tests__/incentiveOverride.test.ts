export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const moment = require('moment');
const { authCookie } = require('./testHelpers');
const {
  getEmployeeIncentiveSummary,
  setIncentiveOverride,
  clearIncentiveOverride,
} = require('../services/incentiveService');

// Runs against the local Firestore emulator (see jest.setup.js).
// Covers the manual-override feature: a supervisor's correction of one
// employee's one month's qualification, which takes precedence over the
// hours-based computation everywhere incentive data is read.
describe('Incentive overrides', () => {
  const createdEmployeeIds: string[] = [];

  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) {
      const sessionsSnap = await db.collection('employees').doc(id).collection('trainingSessions').get();
      for (const doc of sessionsSnap.docs) await doc.ref.delete();
      const overridesSnap = await db.collection('employees').doc(id).collection('incentiveOverrides').get();
      for (const doc of overridesSnap.docs) await doc.ref.delete();
      await db.collection('employees').doc(id).delete();
    }
  });

  async function makeEmployeeWithSessions(overrides: Record<string, any>, sessionDates: { date: string; length: number; trainer?: any }[] = []) {
    const ref = await db.collection('employees').add({ name: 'Test Lifeguard', homeLocation: 'MCAC', isActive: true, ...overrides });
    createdEmployeeIds.push(ref.id);
    for (const s of sessionDates) {
      await ref.collection('trainingSessions').add({
        date: s.date,
        length: s.length,
        status: 'completed',
        trainer: s.trainer !== undefined ? s.trainer : ['some-trainer-id'],
      });
    }
    return ref.id;
  }

  describe('incentiveService — computation', () => {
    it('flips a computed miss to qualified when overridden true', async () => {
      const asOf = moment('2026-06-20');
      const employeeId = await makeEmployeeWithSessions({}, [{ date: '2026-06-05', length: 1 }]); // would miss

      await setIncentiveOverride(employeeId, 2026, 6, true, 'Paper sign-in sheet found', { employeeId: 'sup-1', name: 'Supervisor One' });
      const summary = await getEmployeeIncentiveSummary(employeeId, asOf);

      expect(summary.qualifiedThisMonth).toBe(true);
      expect(summary.qualifiedThisMonthIsOverride).toBe(true);
      expect(summary.hoursByThe15th).toBe(1); // real hours unchanged, still shown
    });

    it('flips a computed qualification to not-qualified when overridden false', async () => {
      const asOf = moment('2026-06-20');
      const employeeId = await makeEmployeeWithSessions({}, [{ date: '2026-06-05', length: 4 }]); // would qualify

      await setIncentiveOverride(employeeId, 2026, 6, false, undefined, { employeeId: 'sup-1', name: 'Supervisor One' });
      const summary = await getEmployeeIncentiveSummary(employeeId, asOf);

      expect(summary.qualifiedThisMonth).toBe(false);
      expect(summary.hoursByThe15th).toBe(4);
    });

    it('reflects a current-month override in both qualifiedThisMonth and the annual grid', async () => {
      const asOf = moment('2026-06-20');
      const employeeId = await makeEmployeeWithSessions({}, [{ date: '2026-06-05', length: 1 }]);

      await setIncentiveOverride(employeeId, 2026, 6, true, undefined, { employeeId: 'sup-1', name: 'Supervisor One' });
      const summary = await getEmployeeIncentiveSummary(employeeId, asOf);

      expect(summary.qualifiedThisMonth).toBe(true);
      const juneEntry = summary.annual.months.find((m: any) => m.month === 6);
      expect(juneEntry.qualified).toBe(true);
      expect(juneEntry.isOverride).toBe(true);
    });

    it('extends the streak through an overridden mid-streak month, agreeing with the annual grid', async () => {
      // April misses on its own, May and June qualify — without an override
      // the streak would only reach back to May.
      const asOf = moment('2026-06-20');
      const employeeId = await makeEmployeeWithSessions({}, [
        { date: '2026-04-03', length: 0 }, // April misses
        { date: '2026-05-03', length: 4 }, // May qualifies
        { date: '2026-06-03', length: 4 }, // June qualifies
      ]);

      const baseline = await getEmployeeIncentiveSummary(employeeId, asOf);
      expect(baseline.currentStreak).toBe(2); // June + May only

      await setIncentiveOverride(employeeId, 2026, 4, true, 'Verified late', { employeeId: 'sup-1', name: 'Supervisor One' });
      const overridden = await getEmployeeIncentiveSummary(employeeId, asOf);

      expect(overridden.currentStreak).toBe(3); // April now bridges the streak
      const aprilEntry = overridden.annual.months.find((m: any) => m.month === 4);
      expect(aprilEntry.qualified).toBe(true);
      expect(aprilEntry.isOverride).toBe(true);
    });

    it('reverts to the computed value once an override is cleared', async () => {
      const asOf = moment('2026-06-20');
      const employeeId = await makeEmployeeWithSessions({}, [{ date: '2026-06-05', length: 1 }]);

      await setIncentiveOverride(employeeId, 2026, 6, true, undefined, { employeeId: 'sup-1', name: 'Supervisor One' });
      expect((await getEmployeeIncentiveSummary(employeeId, asOf)).qualifiedThisMonth).toBe(true);

      await clearIncentiveOverride(employeeId, 2026, 6);
      const summary = await getEmployeeIncentiveSummary(employeeId, asOf);

      expect(summary.qualifiedThisMonth).toBe(false); // back to the hours-based miss
      expect(summary.qualifiedThisMonthIsOverride).toBeUndefined();
    });

    it('does not un-exclude bulk-imported hours — an override only changes the outcome, not the hours', async () => {
      const asOf = moment('2026-06-20');
      const employeeId = await makeEmployeeWithSessions({}, [{ date: '2026-06-01', length: 4, trainer: 'Imported' }]);

      await setIncentiveOverride(employeeId, 2026, 6, true, undefined, { employeeId: 'sup-1', name: 'Supervisor One' });
      const summary = await getEmployeeIncentiveSummary(employeeId, asOf);

      expect(summary.qualifiedThisMonth).toBe(true); // override wins
      expect(summary.hoursByThe15th).toBe(0); // but imported hours still don't count toward the real total
    });
  });

  describe('PUT /api/incentives/override', () => {
    it('saves an override as a supervisor and the roster status reflects it', async () => {
      const asOfMonth = moment().subtract(1, 'month');
      const employeeId = await makeEmployeeWithSessions({}, [
        { date: asOfMonth.clone().date(5).format('YYYY-MM-DD'), length: 1 },
      ]);

      const response = await request(app)
        .put('/api/incentives/override')
        .set('Cookie', authCookie())
        .send({ employeeId, year: asOfMonth.year(), month: asOfMonth.month() + 1, qualified: true, note: 'Backfilled' });

      expect(response.status).toBe(200);

      const doc = await db.collection('employees').doc(employeeId)
        .collection('incentiveOverrides').doc(`${asOfMonth.year()}-${asOfMonth.month() + 1}`).get();
      expect(doc.exists).toBe(true);
      expect(doc.data().qualified).toBe(true);
      expect(doc.data().note).toBe('Backfilled');

      const statusResponse = await request(app)
        .get('/api/incentives/status')
        .query({ asOf: asOfMonth.format('YYYY-MM') })
        .set('Cookie', authCookie());
      const entry = statusResponse.body.employees.find((e: any) => e.employeeId === employeeId);
      expect(entry.qualifiedThisMonth).toBe(true);
      expect(entry.qualifiedThisMonthIsOverride).toBe(true);
    });

    it('rejects a plain trainer', async () => {
      const employeeId = await makeEmployeeWithSessions({});
      const response = await request(app)
        .put('/api/incentives/override')
        .set('Cookie', authCookie({ role: 'trainer' }))
        .send({ employeeId, year: 2026, month: 6, qualified: true });

      expect(response.status).toBe(403);
    });

    it('rejects a future month', async () => {
      const employeeId = await makeEmployeeWithSessions({});
      const future = moment().add(2, 'months');
      const response = await request(app)
        .put('/api/incentives/override')
        .set('Cookie', authCookie())
        .send({ employeeId, year: future.year(), month: future.month() + 1, qualified: true });

      expect(response.status).toBe(400);
    });

    it('rejects an invalid body', async () => {
      const employeeId = await makeEmployeeWithSessions({});
      const response = await request(app)
        .put('/api/incentives/override')
        .set('Cookie', authCookie())
        .send({ employeeId, year: 2026, month: 13, qualified: true });

      expect(response.status).toBe(400);
    });

    it('404s for an unknown employee', async () => {
      const response = await request(app)
        .put('/api/incentives/override')
        .set('Cookie', authCookie())
        .send({ employeeId: 'does-not-exist', year: 2026, month: 6, qualified: true });

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/incentives/override/:employeeId/:year/:month', () => {
    it('clears an override as a supervisor and the status reverts', async () => {
      const asOfMonth = moment().subtract(1, 'month');
      const employeeId = await makeEmployeeWithSessions({}, [
        { date: asOfMonth.clone().date(5).format('YYYY-MM-DD'), length: 1 },
      ]);
      await setIncentiveOverride(employeeId, asOfMonth.year(), asOfMonth.month() + 1, true, undefined, { employeeId: 'sup-1', name: 'Supervisor One' });

      const response = await request(app)
        .delete(`/api/incentives/override/${employeeId}/${asOfMonth.year()}/${asOfMonth.month() + 1}`)
        .set('Cookie', authCookie());

      expect(response.status).toBe(200);
      const doc = await db.collection('employees').doc(employeeId)
        .collection('incentiveOverrides').doc(`${asOfMonth.year()}-${asOfMonth.month() + 1}`).get();
      expect(doc.exists).toBe(false);
    });

    it('rejects a plain trainer', async () => {
      const employeeId = await makeEmployeeWithSessions({});
      const response = await request(app)
        .delete(`/api/incentives/override/${employeeId}/2026/6`)
        .set('Cookie', authCookie({ role: 'trainer' }));

      expect(response.status).toBe(403);
    });
  });

  describe('propagation to self-service and manager-detail views', () => {
    it('reflects an override in the manager employee-detail view', async () => {
      const asOfMonth = moment().subtract(1, 'month');
      const employeeId = await makeEmployeeWithSessions({}, [
        { date: asOfMonth.clone().date(5).format('YYYY-MM-DD'), length: 1 },
      ]);
      await setIncentiveOverride(employeeId, asOfMonth.year(), asOfMonth.month() + 1, true, undefined, { employeeId: 'sup-1', name: 'Supervisor One' });

      // getEmployeeDetailForManager evaluates "as of now", so only a
      // current-month override is guaranteed visible through this endpoint —
      // set the override on the actual current month for this check.
      const now = moment();
      const employeeId2 = await makeEmployeeWithSessions({}, [
        { date: now.clone().date(1).format('YYYY-MM-DD'), length: 1 },
      ]);
      await setIncentiveOverride(employeeId2, now.year(), now.month() + 1, true, undefined, { employeeId: 'sup-1', name: 'Supervisor One' });

      const response = await request(app)
        .get(`/api/employees/${employeeId2}/detail`)
        .set('Cookie', authCookie());

      expect(response.status).toBe(200);
      expect(response.body.incentive.qualifiedThisMonth).toBe(true);
      expect(response.body.incentive.qualifiedThisMonthIsOverride).toBe(true);
    });

    it('reflects an override in the self-service badge lookup', async () => {
      const now = moment();
      const badgeNumber = `TEST-${Math.random().toString(36).slice(2, 8)}`;
      const employeeId = await makeEmployeeWithSessions({
        firstName: 'Jamie', lastName: 'Rivera', badgeNumber,
      }, [{ date: now.clone().date(1).format('YYYY-MM-DD'), length: 1 }]);
      await setIncentiveOverride(employeeId, now.year(), now.month() + 1, true, undefined, { employeeId: 'sup-1', name: 'Supervisor One' });

      const response = await request(app)
        .post('/api/employee/lookup')
        .send({ badgeNumber, firstName: 'Jamie', lastName: 'Rivera' });

      expect(response.status).toBe(200);
      expect(response.body.incentive.qualifiedThisMonth).toBe(true);
      expect(response.body.incentive.qualifiedThisMonthIsOverride).toBe(true);
    });
  });
});
