export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');
const { parseLocalDate } = require('../utils/dateParsing');
const moment = require('moment');

// Runs against the local Firestore emulator (see jest.setup.js), which runs
// in this project's actual server timezone (America/New_York — confirmed
// UTC-4/-5, i.e. behind UTC). A bare "YYYY-MM-DD" string — exactly what
// trainingSessions.date and the bulk importer both store — used to parse via
// the native Date constructor as UTC midnight, which in this timezone is
// *before* local midnight of that day. A session dated the 1st of a month
// (which is exactly what bulk import always uses) would silently fall
// outside that month's [local midnight 1st, local end-of-month] range and
// get attributed to the previous month instead. This confirms the fix.
describe('Date-only strings parse as local midnight, not UTC', () => {
  it('parseLocalDate keeps a day-1 date string on its own calendar day', () => {
    const parsed = parseLocalDate('2026-06-01');
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(5); // June, 0-indexed
    expect(parsed.getDate()).toBe(1);
    expect(parsed.getHours()).toBe(0);
  });

  it('returns null for empty/invalid input instead of an Invalid Date', () => {
    expect(parseLocalDate(null)).toBeNull();
    expect(parseLocalDate(undefined)).toBeNull();
    expect(parseLocalDate('')).toBeNull();
  });

  const createdEmployeeIds: string[] = [];
  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) {
      const sessionsSnap = await db.collection('employees').doc(id).collection('trainingSessions').get();
      for (const doc of sessionsSnap.docs) await doc.ref.delete();
      await db.collection('employees').doc(id).delete();
    }
  });

  it('GET /api/compliance/status attributes a day-1-dated session to its own month, not the prior one', async () => {
    const ref = await db.collection('employees').add({
      name: 'Day One Test',
      homeLocation: 'MCAC',
      isActive: true,
      // A cert on file — this test targets the date-parsing fix, not the
      // separate certificationStatus gate (see certificationGating.test.ts).
      certifications: [{ type: 'Lifeguarding', expirationDate: '2099-01-01' }],
    });
    createdEmployeeIds.push(ref.id);

    const firstOfThisMonth = moment().startOf('month').format('YYYY-MM-DD');
    await ref.collection('trainingSessions').add({
      date: firstOfThisMonth,
      length: 4,
      location: 'MCAC',
      topics: ['Inservice Training'],
      trainer: ['some-real-trainer-id'],
      status: 'completed',
    });

    const response = await request(app).get('/api/compliance/status').set('Cookie', authCookie());
    const row = response.body.allEmployees.find((e: any) => e.id === ref.id);

    // Before the fix, this would be 0 — the session would have been parsed
    // as landing in the previous month and excluded from this month's range.
    expect(row.hoursThisMonth).toBe(4);
    expect(row.status).toBe('compliant');
  });
});
