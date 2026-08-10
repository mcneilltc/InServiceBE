export {};
const { db } = require('../config/firebase');
const moment = require('moment');
const { getEmployeeIncentiveSummary } = require('../services/incentiveService');

// Runs against the local Firestore emulator (see jest.setup.js).
describe('incentiveService.getEmployeeIncentiveSummary', () => {
  const createdEmployeeIds: string[] = [];

  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) {
      const sessionsSnap = await db.collection('employees').doc(id).collection('trainingSessions').get();
      for (const doc of sessionsSnap.docs) await doc.ref.delete();
      await db.collection('employees').doc(id).delete();
    }
  });

  async function makeEmployeeWithSessions(sessionDates: { date: string; length: number }[]) {
    const ref = await db.collection('employees').add({ name: 'Test Lifeguard', homeLocation: 'MCAC' });
    createdEmployeeIds.push(ref.id);
    for (const s of sessionDates) {
      await ref.collection('trainingSessions').add({ date: s.date, length: s.length, status: 'completed' });
    }
    return ref.id;
  }

  it('reports the current month as qualified once 4+ hours are logged by the 15th', async () => {
    const asOf = moment('2026-06-10');
    const employeeId = await makeEmployeeWithSessions([
      { date: '2026-06-05', length: 2 },
      { date: '2026-06-08', length: 2 },
    ]);

    const summary = await getEmployeeIncentiveSummary(employeeId, asOf);

    expect(summary.hoursByThe15th).toBe(4);
    expect(summary.qualifiedThisMonth).toBe(true);
    expect(summary.hoursNeeded).toBe(0);
  });

  it('reports the current month as not-yet-decided when short of hours and before the 15th', async () => {
    const asOf = moment('2026-06-10');
    const employeeId = await makeEmployeeWithSessions([{ date: '2026-06-05', length: 1 }]);

    const summary = await getEmployeeIncentiveSummary(employeeId, asOf);

    expect(summary.hoursByThe15th).toBe(1);
    expect(summary.qualifiedThisMonth).toBeUndefined();
    expect(summary.hoursNeeded).toBe(3);
  });

  it('reports the current month as missed once the 15th has passed without 4 hours', async () => {
    const asOf = moment('2026-06-20');
    const employeeId = await makeEmployeeWithSessions([{ date: '2026-06-05', length: 1 }]);

    const summary = await getEmployeeIncentiveSummary(employeeId, asOf);

    expect(summary.qualifiedThisMonth).toBe(false);
  });

  it('computes a multi-month streak from consecutive qualifying months', async () => {
    const asOf = moment('2026-06-20'); // June's 15th has passed and it qualifies
    const employeeId = await makeEmployeeWithSessions([
      { date: '2026-04-03', length: 4 }, // April qualifies
      { date: '2026-05-03', length: 4 }, // May qualifies
      { date: '2026-06-03', length: 4 }, // June qualifies
    ]);

    const summary = await getEmployeeIncentiveSummary(employeeId, asOf);

    expect(summary.currentStreak).toBe(3);
  });

  it('breaks the streak at the first non-qualifying prior month', async () => {
    const asOf = moment('2026-06-20');
    const employeeId = await makeEmployeeWithSessions([
      { date: '2026-04-03', length: 0 }, // April misses
      { date: '2026-05-03', length: 4 }, // May qualifies
      { date: '2026-06-03', length: 4 }, // June qualifies
    ]);

    const summary = await getEmployeeIncentiveSummary(employeeId, asOf);

    // Streak only counts back through May before hitting April's miss.
    expect(summary.currentStreak).toBe(2);
  });

  it('builds an annual summary covering January through the current month', async () => {
    // March 20th is past March's own 15th cutoff, so all three months
    // (Jan/Feb/Mar) are already decided one way or the other.
    const asOf = moment('2026-03-20');
    const employeeId = await makeEmployeeWithSessions([
      { date: '2026-01-05', length: 4 },
      { date: '2026-02-05', length: 1 }, // misses
    ]);

    const summary = await getEmployeeIncentiveSummary(employeeId, asOf);

    expect(summary.annual.months).toHaveLength(3); // Jan, Feb, Mar
    expect(summary.annual.monthsQualified).toBe(1);
    expect(summary.annual.monthsDecided).toBe(3); // Jan (pass), Feb (miss), Mar (miss — its own 15th has passed)
  });

  it('correctly handles a full 12-month qualifying streak spanning the whole annual grid', async () => {
    // Previously, a streak/annual computation this long meant dozens of
    // separate full-subcollection reads (one per month looked at) — this
    // just confirms the single-read refactor still gets the right answer
    // for the case that used to be the most expensive.
    const asOf = moment('2026-12-20');
    const sessions = [];
    for (let m = 1; m <= 12; m++) {
      sessions.push({ date: `2026-${String(m).padStart(2, '0')}-03`, length: 4 });
    }
    const employeeId = await makeEmployeeWithSessions(sessions);

    const summary = await getEmployeeIncentiveSummary(employeeId, asOf);
    expect(summary.currentStreak).toBe(12);
    expect(summary.annual.monthsQualified).toBe(12);
  });
});
