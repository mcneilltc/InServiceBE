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

  describe('PATCH /api/employees/manual-hours-permissions (bulk)', () => {
    async function makeSupervisor(name: string, canAddManualHours = true) {
      const response = await request(app)
        .post('/api/employees')
        .set('Cookie', authCookie())
        .send({ name, isSupervisor: true, canAddManualHours });
      createdEmployeeIds.push(response.body.id);
      return response.body.id;
    }

    it('applies canAddManualHours to multiple supervisors in one request', async () => {
      const a = await makeSupervisor('Bulk Supervisor A', true);
      const b = await makeSupervisor('Bulk Supervisor B', true);

      const response = await request(app)
        .patch('/api/employees/manual-hours-permissions')
        .set('Cookie', authCookie())
        .send({ updates: [{ employeeId: a, canAddManualHours: false }, { employeeId: b, canAddManualHours: false }] });

      expect(response.status).toBe(200);
      expect(response.body.updatedCount).toBe(2);

      const [docA, docB] = await Promise.all([
        db.collection('employees').doc(a).get(),
        db.collection('employees').doc(b).get(),
      ]);
      expect(docA.data().canAddManualHours).toBe(false);
      expect(docB.data().canAddManualHours).toBe(false);
    });

    it('supports mixed true/false values in the same batch', async () => {
      const a = await makeSupervisor('Mixed Supervisor A', false);
      const b = await makeSupervisor('Mixed Supervisor B', false);

      const response = await request(app)
        .patch('/api/employees/manual-hours-permissions')
        .set('Cookie', authCookie())
        .send({ updates: [{ employeeId: a, canAddManualHours: true }, { employeeId: b, canAddManualHours: false }] });

      expect(response.status).toBe(200);

      const [docA, docB] = await Promise.all([
        db.collection('employees').doc(a).get(),
        db.collection('employees').doc(b).get(),
      ]);
      expect(docA.data().canAddManualHours).toBe(true);
      expect(docB.data().canAddManualHours).toBe(false);
    });

    it('rejects the whole batch (no partial writes) if any target is not a supervisor', async () => {
      const supervisorId = await makeSupervisor('Valid Supervisor', true);
      const nonSupervisorResponse = await request(app)
        .post('/api/employees')
        .set('Cookie', authCookie())
        .send({ name: 'Just A Lifeguard' });
      const nonSupervisorId = nonSupervisorResponse.body.id;
      createdEmployeeIds.push(nonSupervisorId);

      const response = await request(app)
        .patch('/api/employees/manual-hours-permissions')
        .set('Cookie', authCookie())
        .send({
          updates: [
            { employeeId: supervisorId, canAddManualHours: false },
            { employeeId: nonSupervisorId, canAddManualHours: false },
          ],
        });

      expect(response.status).toBe(400);
      expect(response.body.notSupervisors).toContain(nonSupervisorId);

      // Confirm no partial write happened to the valid supervisor either.
      const doc = await db.collection('employees').doc(supervisorId).get();
      expect(doc.data().canAddManualHours).toBe(true);
    });

    it('rejects the whole batch if any employeeId does not exist', async () => {
      const supervisorId = await makeSupervisor('Another Valid Supervisor', true);

      const response = await request(app)
        .patch('/api/employees/manual-hours-permissions')
        .set('Cookie', authCookie())
        .send({
          updates: [
            { employeeId: supervisorId, canAddManualHours: false },
            { employeeId: 'does-not-exist', canAddManualHours: false },
          ],
        });

      expect(response.status).toBe(400);
      expect(response.body.notFound).toContain('does-not-exist');
    });

    it('rejects an empty updates array', async () => {
      const response = await request(app)
        .patch('/api/employees/manual-hours-permissions')
        .set('Cookie', authCookie())
        .send({ updates: [] });

      expect(response.status).toBe(400);
    });
  });
});
