export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// A newly added/imported employee with no certification on file yet isn't
// tracked for inservice-hour compliance until one is added (see
// utils/certificationStatus.ts). Covers every surface that computes or
// displays compliance status.
describe('Employees without a certification on file are left out of compliance tracking', () => {
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
      name: 'Test Lifeguard',
      firstName: 'Test',
      lastName: 'Lifeguard',
      badgeNumber: `TEST-${Math.random().toString(36).slice(2, 8)}`,
      homeLocation: 'MCAC',
      isActive: true,
      ...overrides,
    });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  const WITH_CERT = { certifications: [{ type: 'Lifeguarding', expirationDate: '2099-01-01' }] };

  it('GET /api/compliance/status leaves an uncertified employee out of allEmployees and site counts', async () => {
    await makeEmployee({ name: 'No Cert Yet' });
    await makeEmployee({ name: 'Has Cert', ...WITH_CERT });

    const response = await request(app).get('/api/compliance/status').set('Cookie', authCookie());

    expect(response.status).toBe(200);
    const names = response.body.allEmployees.map((e: any) => e.name);
    expect(names).toContain('Has Cert');
    expect(names).not.toContain('No Cert Yet');
    expect(response.body.bySite.MCAC.total).toBe(1);
  });

  it('an uncertified employee with 0 hours never appears in the zero-hours alert', async () => {
    await makeEmployee({ name: 'Uncertified Zero Hours' });

    const response = await request(app).get('/api/compliance/status').set('Cookie', authCookie());

    expect(response.status).toBe(200);
    const names = response.body.alerts.midMonth.map((e: any) => e.name);
    expect(names).not.toContain('Uncertified Zero Hours');
  });

  it('adding a certification brings the employee into compliance tracking', async () => {
    const employeeId = await makeEmployee({ name: 'Newly Certified' });

    const before = await request(app).get('/api/compliance/status').set('Cookie', authCookie());
    expect(before.body.allEmployees.map((e: any) => e.id)).not.toContain(employeeId);

    await db.collection('employees').doc(employeeId).update(WITH_CERT);

    const after = await request(app).get('/api/compliance/status').set('Cookie', authCookie());
    expect(after.body.allEmployees.map((e: any) => e.id)).toContain(employeeId);
  });

  it('GET /api/dashboard/stats leaves an uncertified employee out of employeesNeedingTraining', async () => {
    await makeEmployee({ name: 'No Cert Dashboard' });
    await makeEmployee({ name: 'Certified Dashboard', ...WITH_CERT });

    const response = await request(app)
      .get('/api/dashboard/stats')
      .set('Cookie', authCookie())
      .query({ period: 'month' });

    expect(response.status).toBe(200);
    const names = response.body.employeesNeedingTraining.map((e: any) => e.name);
    expect(names).toContain('Certified Dashboard');
    expect(names).not.toContain('No Cert Dashboard');
  });

  it('GET /api/reports/hours tags (not excludes) an uncertified employee as pendingCertification', async () => {
    await makeEmployee({ name: 'No Cert Report' });

    const response = await request(app).get('/api/reports/hours').set('Cookie', authCookie());

    expect(response.status).toBe(200);
    const row = response.body.find((r: any) => r.name === 'No Cert Report');
    expect(row).toBeDefined();
    expect(row.status).toBe('pendingCertification');
    expect(row.hoursLeft).toBe(0);
  });

  it('POST /api/employee/lookup reports pending_certification status for an uncertified employee', async () => {
    const badgeNumber = `TEST-${Math.random().toString(36).slice(2, 8)}`;
    await makeEmployee({ badgeNumber, firstName: 'No', lastName: 'Cert' });

    const response = await request(app)
      .post('/api/employee/lookup')
      .send({ badgeNumber, firstName: 'No', lastName: 'Cert' });

    expect(response.status).toBe(200);
    expect(response.body.compliance.status).toBe('pending_certification');
  });

  it('POST /api/employee/lookup reports normal compliance status once certified', async () => {
    const badgeNumber = `TEST-${Math.random().toString(36).slice(2, 8)}`;
    await makeEmployee({ badgeNumber, firstName: 'Has', lastName: 'Cert', ...WITH_CERT });

    const response = await request(app)
      .post('/api/employee/lookup')
      .send({ badgeNumber, firstName: 'Has', lastName: 'Cert' });

    expect(response.status).toBe(200);
    expect(response.body.compliance.status).not.toBe('pending_certification');
  });
});
