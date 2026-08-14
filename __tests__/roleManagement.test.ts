export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// Runs against the local Firestore emulator (see jest.setup.js). Covers the
// two capabilities reserved for Admin alone (see utils/roles.ts) — changing
// anyone's role, and managing sites — both live-checked against Firestore,
// never the session JWT's role claim (see employeesController.js).
describe('Admin-exclusive: role changes', () => {
  const createdEmployeeIds: string[] = [];

  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) await db.collection('employees').doc(id).delete();
  });

  async function makeActor(role: string) {
    const ref = await db.collection('employees').add({ name: 'Test Actor', role });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  async function makeTarget(role: string | null = null) {
    const ref = await db.collection('employees').add({ name: 'Test Target', role });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  it('rejects a Senior Supervisor changing another employee\'s role', async () => {
    const actorId = await makeActor('seniorSupervisor');
    const targetId = await makeTarget();

    const response = await request(app)
      .put(`/api/employees/${targetId}`)
      .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId: actorId }))
      .send({ role: 'supervisor' });

    expect(response.status).toBe(403);

    const saved = await db.collection('employees').doc(targetId).get();
    expect(saved.data()?.role).toBeNull();
  });

  it('rejects a Senior Supervisor assigning a role on create', async () => {
    const actorId = await makeActor('seniorSupervisor');

    const response = await request(app)
      .post('/api/employees')
      .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId: actorId }))
      .send({ name: 'New Hire', role: 'trainer' });

    expect(response.status).toBe(403);
  });

  it('allows a Senior Supervisor to create an employee with no role at all', async () => {
    const actorId = await makeActor('seniorSupervisor');

    const response = await request(app)
      .post('/api/employees')
      .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId: actorId }))
      .send({ name: 'New Hire' });

    expect(response.status).toBe(201);
    createdEmployeeIds.push(response.body.id);
    expect(response.body.employee.role).toBeNull();
  });

  it('allows a Senior Supervisor to edit other fields without touching role', async () => {
    const actorId = await makeActor('seniorSupervisor');
    const targetId = await makeTarget('trainer');

    const response = await request(app)
      .put(`/api/employees/${targetId}`)
      .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId: actorId }))
      .send({ phone: '555-0100' });

    expect(response.status).toBe(200);
    const saved = await db.collection('employees').doc(targetId).get();
    expect(saved.data()?.role).toBe('trainer');
    expect(saved.data()?.phone).toBe('555-0100');
  });

  it('allows an Admin to promote another employee\'s role', async () => {
    const actorId = await makeActor('admin');
    const targetId = await makeTarget('supervisor');

    const response = await request(app)
      .put(`/api/employees/${targetId}`)
      .set('Cookie', authCookie({ role: 'admin', employeeId: actorId }))
      .send({ role: 'seniorSupervisor' });

    expect(response.status).toBe(200);
    const saved = await db.collection('employees').doc(targetId).get();
    expect(saved.data()?.role).toBe('seniorSupervisor');
  });

  it('allows an Admin to assign a role on create', async () => {
    const actorId = await makeActor('admin');

    const response = await request(app)
      .post('/api/employees')
      .set('Cookie', authCookie({ role: 'admin', employeeId: actorId }))
      .send({ name: 'New Hire', role: 'supervisor' });

    expect(response.status).toBe(201);
    createdEmployeeIds.push(response.body.id);
    expect(response.body.employee.role).toBe('supervisor');
  });

  // Regression coverage for the same class of bug fixed elsewhere in this
  // app — the live Firestore value must win over whatever the session JWT
  // happened to claim at login, since role changes are the most sensitive
  // action in the system.
  it('blocks immediately when demoted from admin in Firestore, even if the stale session JWT still claims admin', async () => {
    const actorId = await makeActor('seniorSupervisor');
    const targetId = await makeTarget();

    const response = await request(app)
      .put(`/api/employees/${targetId}`)
      // Simulates a session issued before this actor was demoted from admin.
      .set('Cookie', authCookie({ role: 'admin', employeeId: actorId }))
      .send({ role: 'trainer' });

    expect(response.status).toBe(403);
  });
});

describe('Admin-exclusive: site management', () => {
  const createdSiteIds: string[] = [];

  afterEach(async () => {
    for (const id of createdSiteIds.splice(0)) await db.collection('sites').doc(id).delete();
  });

  it('rejects a Senior Supervisor creating a site', async () => {
    const response = await request(app)
      .post('/api/sites')
      .set('Cookie', authCookie({ role: 'seniorSupervisor' }))
      .send({ siteName: 'New Test Site' });

    expect(response.status).toBe(403);
  });

  it('allows an Admin to create a site', async () => {
    const response = await request(app)
      .post('/api/sites')
      .set('Cookie', authCookie({ role: 'admin' }))
      .send({ siteName: 'New Test Site' });

    expect(response.status).toBe(201);
    createdSiteIds.push(response.body.site?.id || response.body.id);
  });

  it('allows a Senior Supervisor to still read the site list', async () => {
    const response = await request(app)
      .get('/api/sites')
      .set('Cookie', authCookie({ role: 'seniorSupervisor' }));

    expect(response.status).toBe(200);
  });

  it('rejects a plain Supervisor deleting a site', async () => {
    const createResponse = await request(app)
      .post('/api/sites')
      .set('Cookie', authCookie({ role: 'admin' }))
      .send({ siteName: 'Site To Keep' });
    const siteId = createResponse.body.site?.id || createResponse.body.id;
    createdSiteIds.push(siteId);

    const response = await request(app)
      .delete(`/api/sites/${siteId}`)
      .set('Cookie', authCookie({ role: 'supervisor' }));

    expect(response.status).toBe(403);
  });
});
