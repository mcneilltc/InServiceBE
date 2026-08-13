export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// employees.canAddManualHours — persisted via POST/PUT /api/employees, then
// read back in authService.resolveRole to gate POST
// /api/training-sessions/:employeeId (see manualHoursPermission.test.ts).
describe('employees.canAddManualHours flag persistence', () => {
  const createdEmployeeIds: string[] = [];

  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) {
      await db.collection('employees').doc(id).delete();
    }
  });

  it('defaults a new supervisor to canAddManualHours: true when not specified', async () => {
    const response = await request(app)
      .post('/api/employees')
      .set('Cookie', authCookie())
      .send({ name: 'New Supervisor', isSupervisor: true });

    expect(response.status).toBe(201);
    createdEmployeeIds.push(response.body.id);
    expect(response.body.employee.canAddManualHours).toBe(true);
  });

  it('respects an explicit false on create', async () => {
    const response = await request(app)
      .post('/api/employees')
      .set('Cookie', authCookie())
      .send({ name: 'Restricted Supervisor', isSupervisor: true, canAddManualHours: false });

    expect(response.status).toBe(201);
    createdEmployeeIds.push(response.body.id);
    expect(response.body.employee.canAddManualHours).toBe(false);
  });

  it('stores null for a non-supervisor regardless of the submitted value', async () => {
    const response = await request(app)
      .post('/api/employees')
      .set('Cookie', authCookie())
      .send({ name: 'Just A Trainer', isSupervisor: false, isTrainer: true, canAddManualHours: false });

    expect(response.status).toBe(201);
    createdEmployeeIds.push(response.body.id);
    expect(response.body.employee.canAddManualHours).toBeNull();
  });

  it('can be revoked and restored via update', async () => {
    const createResponse = await request(app)
      .post('/api/employees')
      .set('Cookie', authCookie())
      .send({ name: 'Toggle Supervisor', isSupervisor: true });
    const employeeId = createResponse.body.id;
    createdEmployeeIds.push(employeeId);

    const revoke = await request(app)
      .put(`/api/employees/${employeeId}`)
      .set('Cookie', authCookie())
      .send({ canAddManualHours: false });
    expect(revoke.status).toBe(200);
    expect(revoke.body.employee.canAddManualHours).toBe(false);

    const restore = await request(app)
      .put(`/api/employees/${employeeId}`)
      .set('Cookie', authCookie())
      .send({ canAddManualHours: true });
    expect(restore.status).toBe(200);
    expect(restore.body.employee.canAddManualHours).toBe(true);
  });
});
