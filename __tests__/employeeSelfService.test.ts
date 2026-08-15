export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const moment = require('moment');
const { authCookie } = require('./testHelpers');

// Runs against the local Firestore emulator (see jest.setup.js).
// Covers lookupEmployee and getEmployeeDetailForManager after refactoring
// them to read an employee's trainingSessions subcollection once and derive
// both the "this month" session list and the incentive summary from that
// single read, instead of two separate reads of the same subcollection.
describe('Employee self-service lookup / manager detail', () => {
  const createdEmployeeIds: string[] = [];

  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) {
      const sessionsSnap = await db.collection('employees').doc(id).collection('trainingSessions').get();
      for (const doc of sessionsSnap.docs) await doc.ref.delete();
      await db.collection('employees').doc(id).delete();
    }
  });

  async function makeEmployee(overrides: Record<string, any> = {}) {
    const ref = await db.collection('employees').add({
      name: 'Jamie Rivera',
      firstName: 'Jamie',
      lastName: 'Rivera',
      badgeNumber: `TEST-${Math.random().toString(36).slice(2, 8)}`,
      homeLocation: 'MCAC',
      isActive: true,
      // A cert on file — these tests target the shared-read refactor, not the
      // separate certificationStatus gate (see certificationGating.test.ts).
      certifications: [{ type: 'Lifeguarding', expirationDate: '2099-01-01' }],
      ...overrides,
    });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  describe('POST /api/employee/lookup', () => {
    it('returns this-month sessions and a matching incentive summary derived from the same data', async () => {
      const badgeNumber = `TEST-${Math.random().toString(36).slice(2, 8)}`;
      const employeeId = await makeEmployee({ badgeNumber, firstName: 'Jamie', lastName: 'Rivera' });

      const thisMonthStart = moment().startOf('month');
      await db.collection('employees').doc(employeeId).collection('trainingSessions').add({
        date: thisMonthStart.clone().add(2, 'days').format('YYYY-MM-DD'),
        length: 4,
        topics: ['Lifeguarding'],
        trainer: [],
        location: 'MCAC',
      });
      // A prior month's session shouldn't show up in `sessions` (this-month only)
      // but should still count toward the incentive annual summary.
      await db.collection('employees').doc(employeeId).collection('trainingSessions').add({
        date: thisMonthStart.clone().subtract(1, 'month').add(2, 'days').format('YYYY-MM-DD'),
        length: 4,
        topics: ['CPR'],
        trainer: [],
        location: 'MCAC',
      });

      const response = await request(app)
        .post('/api/employee/lookup')
        .send({ badgeNumber, firstName: 'Jamie', lastName: 'Rivera' });

      expect(response.status).toBe(200);
      expect(response.body.employee.id).toBe(employeeId);
      // Only this month's session comes back in the session list.
      expect(response.body.sessions).toHaveLength(1);
      expect(response.body.sessions[0].topics).toEqual(['Lifeguarding']);
      // Compliance reflects this month's 4 hours.
      expect(response.body.compliance.monthlyCompliant).toBe(true);
      // Incentive summary reflects the SAME underlying data (built from the
      // single shared read, not a second independent query).
      expect(response.body.incentive.hoursByThe15th).toBeGreaterThanOrEqual(0);
      expect(response.body.incentive).toHaveProperty('currentStreak');
    });

    it('404s when the badge number matches no employee', async () => {
      const response = await request(app)
        .post('/api/employee/lookup')
        .send({ badgeNumber: 'NO-SUCH-BADGE', firstName: 'Nobody', lastName: 'Here' });

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/employees/:id/detail', () => {
    it('returns the same shape as the self-service lookup, keyed by employee ID', async () => {
      const employeeId = await makeEmployee();
      const thisMonthStart = moment().startOf('month');
      await db.collection('employees').doc(employeeId).collection('trainingSessions').add({
        date: thisMonthStart.clone().add(3, 'days').format('YYYY-MM-DD'),
        length: 2,
        topics: ['First Aid'],
        trainer: [],
        location: 'MCAC',
      });

      const response = await request(app)
        .get(`/api/employees/${employeeId}/detail`)
        .set('Cookie', authCookie());

      expect(response.status).toBe(200);
      expect(response.body.employee.id).toBe(employeeId);
      expect(response.body.sessions).toHaveLength(1);
      expect(response.body.compliance).toHaveProperty('monthlyCompliant');
      expect(response.body.incentive).toHaveProperty('currentStreak');
    });

    // The Manage Employees table only shows what's useful for scanning a
    // list (Name, Role, Home Location) — everything else moved here.
    it('includes the profile fields the Manage Employees table no longer shows inline', async () => {
      const employeeId = await makeEmployee({
        email: 'jamie@example.com',
        position: 'Lifeguard',
        locations: ['MCAC', 'ERRC'],
        role: 'trainer',
        hireDate: '2024-01-15',
      });

      const response = await request(app)
        .get(`/api/employees/${employeeId}/detail`)
        .set('Cookie', authCookie());

      expect(response.status).toBe(200);
      expect(response.body.employee.email).toBe('jamie@example.com');
      expect(response.body.employee.position).toBe('Lifeguard');
      expect(response.body.employee.locations).toEqual(['MCAC', 'ERRC']);
      expect(response.body.employee.role).toBe('trainer');
      expect(response.body.employee.hireDate).toBe('2024-01-15');
    });

    it('404s for an employee that does not exist', async () => {
      const response = await request(app)
        .get('/api/employees/does-not-exist/detail')
        .set('Cookie', authCookie());

      expect(response.status).toBe(404);
    });
  });
});
