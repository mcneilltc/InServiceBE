export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const moment = require('moment');
const { authCookie } = require('./testHelpers');

// Runs against the local Firestore emulator (see jest.setup.js) — safe to
// create/delete real-looking documents here.
describe('POST /api/checkin — self check-in start-time cutoff', () => {
  const employee = {
    firstName: 'Late',
    lastName: 'Lifeguard',
    badgeNumber: 'CUTOFF-TEST-1',
    homeLocation: 'MCAC',
  };
  let employeeId: string;
  const createdSessionIds: string[] = [];

  beforeEach(async () => {
    const empRef = await db.collection('employees').add(employee);
    employeeId = empRef.id;
  });

  afterEach(async () => {
    await db.collection('employees').doc(employeeId).delete();
    for (const id of createdSessionIds.splice(0)) {
      await db.collection('sessions').doc(id).delete();
      const checkins = await db.collection('checkins').where('sessionId', '==', id).get();
      await Promise.all(checkins.docs.map((d: any) => d.ref.delete()));
    }
  });

  async function createSession(startTime: string, date: string) {
    const ref = await db.collection('sessions').add({
      date,
      startTime,
      location: 'MCAC',
      status: 'scheduled',
      topics: ['CPR'],
      trainer: ['trainer-1'],
      trainees: [],
    });
    createdSessionIds.push(ref.id);
    return ref.id;
  }

  it('rejects self check-in more than 1 minute after the session start time', async () => {
    const start = moment().subtract(5, 'minutes');
    const sessionId = await createSession(start.format('hh:mm A'), start.format('YYYY-MM-DD'));

    const response = await request(app).post('/api/checkin').send({
      sessionId,
      badgeNumber: employee.badgeNumber,
      firstName: employee.firstName,
      lastName: employee.lastName,
    });

    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/self check-in has closed/i);
  });

  it('allows self check-in within 1 minute of the session start time', async () => {
    const start = moment();
    const sessionId = await createSession(start.format('hh:mm A'), start.format('YYYY-MM-DD'));

    const response = await request(app).post('/api/checkin').send({
      sessionId,
      badgeNumber: employee.badgeNumber,
      firstName: employee.firstName,
      lastName: employee.lastName,
    });

    expect(response.status).toBe(200);
  });

  it('rejects self check-in more than 15 minutes before the session start time', async () => {
    const start = moment().add(30, 'minutes');
    const sessionId = await createSession(start.format('hh:mm A'), start.format('YYYY-MM-DD'));

    const response = await request(app).post('/api/checkin').send({
      sessionId,
      badgeNumber: employee.badgeNumber,
      firstName: employee.firstName,
      lastName: employee.lastName,
    });

    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/isn't open yet/i);
  });

  it('allows self check-in within 15 minutes before the session start time', async () => {
    const start = moment().add(10, 'minutes');
    const sessionId = await createSession(start.format('hh:mm A'), start.format('YYYY-MM-DD'));

    const response = await request(app).post('/api/checkin').send({
      sessionId,
      badgeNumber: employee.badgeNumber,
      firstName: employee.firstName,
      lastName: employee.lastName,
    });

    expect(response.status).toBe(200);
  });

  it('still allows a trainer to manually add a late employee via employeeId', async () => {
    const start = moment().subtract(30, 'minutes');
    const sessionId = await createSession(start.format('hh:mm A'), start.format('YYYY-MM-DD'));

    const response = await request(app).post('/api/checkin').send({
      sessionId,
      employeeId,
    });

    expect(response.status).toBe(200);
  });
});

// Runs against the local Firestore emulator (see jest.setup.js).
describe('GET /api/checkin', () => {
  const createdEmployeeIds: string[] = [];
  const createdCheckinIds: string[] = [];

  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) await db.collection('employees').doc(id).delete();
    for (const id of createdCheckinIds.splice(0)) await db.collection('checkins').doc(id).delete();
  });

  async function makeEmployee(overrides: Record<string, any> = {}) {
    const ref = await db.collection('employees').add({
      name: 'Test Employee',
      homeLocation: 'MCAC',
      isActive: true,
      ...overrides,
    });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  async function makeCheckin(overrides: Record<string, any> = {}) {
    const ref = await db.collection('checkins').add({
      sessionId: 'session-x',
      employeeId: 'employee-x',
      name: 'Test Employee',
      location: 'MCAC',
      checkinTime: moment().subtract(1, 'day').toISOString(),
      ...overrides,
    });
    createdCheckinIds.push(ref.id);
    return ref.id;
  }

  it('only returns check-ins within the recent window, excluding older ones', async () => {
    await makeCheckin({ checkinTime: moment().subtract(2, 'days').toISOString(), name: 'Recent Person' });
    await makeCheckin({ checkinTime: moment().subtract(45, 'days').toISOString(), name: 'Stale Person' });

    const response = await request(app).get('/api/checkin').set('Cookie', authCookie());

    expect(response.status).toBe(200);
    const names = response.body.map((c: any) => c.name);
    expect(names).toContain('Recent Person');
    expect(names).not.toContain('Stale Person');
  });

  it('filters by training location', async () => {
    await makeCheckin({ location: 'MCAC', name: 'MCAC Person' });
    await makeCheckin({ location: 'ERRC', name: 'ERRC Person' });

    const response = await request(app).get('/api/checkin?location=ERRC').set('Cookie', authCookie());

    expect(response.status).toBe(200);
    const names = response.body.map((c: any) => c.name);
    expect(names).toEqual(['ERRC Person']);
  });

  it('scopes by the checked-in employee\'s home location for a location-scoped supervisor', async () => {
    const mcacEmployeeId = await makeEmployee({ homeLocation: 'MCAC' });
    const errcEmployeeId = await makeEmployee({ homeLocation: 'ERRC' });
    await makeCheckin({ employeeId: mcacEmployeeId, name: 'MCAC Homebased', location: 'Rays Splash Planet' });
    await makeCheckin({ employeeId: errcEmployeeId, name: 'ERRC Homebased', location: 'Rays Splash Planet' });

    const response = await request(app)
      .get('/api/checkin')
      .set('Cookie', authCookie({ supervisorScope: 'locations', supervisorLocations: ['MCAC'] }));

    expect(response.status).toBe(200);
    const names = response.body.map((c: any) => c.name);
    expect(names).toEqual(['MCAC Homebased']);
  });

  it('rejects a trainer (supervisor-only route)', async () => {
    const response = await request(app)
      .get('/api/checkin')
      .set('Cookie', authCookie({ role: 'trainer', supervisorScope: null }));

    expect(response.status).toBe(403);
  });
});
