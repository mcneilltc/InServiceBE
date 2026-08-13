export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// Runs against the local Firestore emulator (see jest.setup.js).
describe('Hours-exempt supervisors are excluded from compliance tracking', () => {
  const createdEmployeeIds: string[] = [];

  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) await db.collection('employees').doc(id).delete();
  });

  async function makeEmployee(overrides: Record<string, any> = {}) {
    const ref = await db.collection('employees').add({
      name: 'Test Employee',
      homeLocation: 'ERRC',
      isActive: true,
      // A certification on file by default — these tests target the exemption
      // flag specifically, not the separate certificationStatus gate (see
      // certificationGating.test.ts).
      certifications: [{ type: 'Lifeguarding', expirationDate: '2099-01-01' }],
      ...overrides,
    });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  it('GET /api/compliance/status leaves an exempt employee out of allEmployees and site counts', async () => {
    await makeEmployee({ name: 'Exempt Supervisor', isSupervisor: true, isExemptFromHoursRequirement: true });
    await makeEmployee({ name: 'Regular Lifeguard' });

    const response = await request(app).get('/api/compliance/status').set('Cookie', authCookie());

    expect(response.status).toBe(200);
    const names = response.body.allEmployees.map((e: any) => e.name);
    expect(names).toContain('Regular Lifeguard');
    expect(names).not.toContain('Exempt Supervisor');
    // Only the non-exempt employee should count toward the site total.
    expect(response.body.bySite.ERRC.total).toBe(1);
  });

  it('an exempt employee with 0 hours never appears in the zero-hours alert', async () => {
    await makeEmployee({ name: 'Exempt With Zero Hours', isSupervisor: true, isExemptFromHoursRequirement: true });

    const response = await request(app).get('/api/compliance/status').set('Cookie', authCookie());

    expect(response.status).toBe(200);
    const names = response.body.alerts.midMonth.map((e: any) => e.name);
    expect(names).not.toContain('Exempt With Zero Hours');
  });
});
