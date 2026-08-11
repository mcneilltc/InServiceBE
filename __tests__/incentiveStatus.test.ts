export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const moment = require('moment');
const { authCookie } = require('./testHelpers');

// Runs against the local Firestore emulator (see jest.setup.js).
// GET /api/incentives/status was refactored to fetch the incentiveTiers
// collection once for the whole roster instead of once per employee — this
// confirms tier assignment still works correctly for every employee off
// that single shared list.
describe('GET /api/incentives/status', () => {
  const createdEmployeeIds: string[] = [];
  const createdTierIds: string[] = [];

  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) {
      const sessionsSnap = await db.collection('employees').doc(id).collection('trainingSessions').get();
      for (const doc of sessionsSnap.docs) await doc.ref.delete();
      await db.collection('employees').doc(id).delete();
    }
    for (const id of createdTierIds.splice(0)) {
      await db.collection('incentiveTiers').doc(id).delete();
    }
  });

  async function makeEmployee(name: string, homeLocation: string) {
    const ref = await db.collection('employees').add({ name, homeLocation, isActive: true });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  async function makeTier(streakLength: number, rewardLabel: string) {
    const ref = await db.collection('incentiveTiers').add({ streakLength, rewardLabel });
    createdTierIds.push(ref.id);
    return ref.id;
  }

  async function qualifyMonth(employeeId: string, monthsAgo: number) {
    const date = moment().subtract(monthsAgo, 'months').startOf('month').add(2, 'days');
    await db.collection('employees').doc(employeeId).collection('trainingSessions').add({
      date: date.format('YYYY-MM-DD'),
      length: 4,
    });
  }

  it('assigns the correct tier to each employee using one shared tiers list', async () => {
    await makeTier(1, 'Bronze');
    await makeTier(3, 'Silver');

    const noStreak = await makeEmployee('No Streak', 'MCAC');
    const oneMonth = await makeEmployee('One Month', 'MCAC');
    await qualifyMonth(oneMonth, 0);
    const threeMonths = await makeEmployee('Three Months', 'MCAC');
    await qualifyMonth(threeMonths, 0);
    await qualifyMonth(threeMonths, 1);
    await qualifyMonth(threeMonths, 2);

    const response = await request(app).get('/api/incentives/status').set('Cookie', authCookie());

    expect(response.status).toBe(200);
    const byId: Record<string, any> = {};
    response.body.employees.forEach((e: any) => { byId[e.employeeId] = e; });

    expect(byId[noStreak].currentTier).toBeNull();
    expect(byId[oneMonth].currentTier?.rewardLabel).toBe('Bronze');
    expect(byId[threeMonths].currentTier?.rewardLabel).toBe('Silver');
  });

  it('scopes the roster by home site when sites is passed', async () => {
    const errcEmp = await makeEmployee('ERRC Person', 'ERRC');
    const mcacEmp = await makeEmployee('MCAC Person', 'MCAC');

    const response = await request(app)
      .get('/api/incentives/status')
      .query({ sites: 'ERRC' })
      .set('Cookie', authCookie());

    const ids = response.body.employees.map((e: any) => e.employeeId);
    expect(ids).toContain(errcEmp);
    expect(ids).not.toContain(mcacEmp);
  });
});
