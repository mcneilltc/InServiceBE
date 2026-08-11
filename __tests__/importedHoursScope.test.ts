export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');
const moment = require('moment');

// Runs against the local Firestore emulator (see jest.setup.js).
// Bulk-imported historical hours (trainer: 'Imported', dated the 1st of the
// backfilled month) must still count toward the baseline compliance
// requirement (this-month hours, dashboard totals) but must NOT count
// toward the stricter incentive program, which requires genuine completion
// verified before the 15th. This confirms both halves of that split.
describe('Bulk-imported hours: count for compliance, excluded from incentive', () => {
  const createdEmployeeIds: string[] = [];

  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) {
      const sessionsSnap = await db.collection('employees').doc(id).collection('trainingSessions').get();
      for (const doc of sessionsSnap.docs) await doc.ref.delete();
      await db.collection('employees').doc(id).delete();
    }
  });

  it('an imported session for the current month counts toward compliance but not the incentive', async () => {
    const ref = await db.collection('employees').add({
      name: 'Imported Hours Test',
      homeLocation: 'MCAC',
      isActive: true,
    });
    createdEmployeeIds.push(ref.id);

    // NOTE: the real bulk importer always dates a backfilled month on the
    // 1st, but a bare "YYYY-MM-DD" string parses as UTC midnight — in any
    // timezone behind UTC (this server runs America/New_York) that's
    // *before* local midnight of the 1st, which pushes it across the month
    // boundary into the PREVIOUS month's range in complianceController's
    // moment().startOf('month') comparison. That's a separate, real bug
    // (raised alongside this fix, not fixed here) — using the 5th instead
    // of the 1st keeps this test isolated to the incentive-exclusion
    // behavior it's actually meant to verify.
    const dateStr = moment().startOf('month').add(4, 'days').format('YYYY-MM-DD');
    await ref.collection('trainingSessions').add({
      date: dateStr,
      length: 4,
      location: 'MCAC',
      topics: ['Inservice Training'],
      trainer: 'Imported',
      status: 'completed',
    });

    // Compliance: imported hours count normally toward this month's total.
    const complianceResponse = await request(app).get('/api/compliance/status').set('Cookie', authCookie());
    const complianceRow = complianceResponse.body.allEmployees.find((e: any) => e.id === ref.id);
    expect(complianceRow.hoursThisMonth).toBe(4);
    expect(complianceRow.status).toBe('compliant');

    // Incentive: the same session must NOT qualify the month. Whether the
    // real "today" this test happens to run on is before or after the 15th
    // decides whether that reads as undecided (undefined) or a confirmed
    // miss (false) — either is correct here; what matters is it's never true.
    const incentiveResponse = await request(app).get('/api/incentives/status').set('Cookie', authCookie());
    const incentiveRow = incentiveResponse.body.employees.find((e: any) => e.employeeId === ref.id);
    expect(incentiveRow.hoursByThe15th).toBe(0);
    expect(incentiveRow.qualifiedThisMonth).not.toBe(true);
  });
});
