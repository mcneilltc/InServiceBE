export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const moment = require('moment');
const { authCookie } = require('./testHelpers');

// Runs against the local Firestore emulator (see jest.setup.js).
describe('GET /api/shifts/attendance', () => {
  const createdEmployeeIds: string[] = [];
  const createdShiftIds: string[] = [];
  const createdCheckinIds: string[] = [];

  afterEach(async () => {
    for (const id of createdEmployeeIds.splice(0)) await db.collection('employees').doc(id).delete();
    for (const id of createdShiftIds.splice(0)) await db.collection('shifts').doc(id).delete();
    for (const id of createdCheckinIds.splice(0)) await db.collection('checkins').doc(id).delete();
  });

  async function makeEmployee(overrides: Record<string, any> = {}) {
    const ref = await db.collection('employees').add({
      firstName: 'Test',
      lastName: 'Lifeguard',
      badgeNumber: `SHIFT-TEST-${Math.random().toString(36).slice(2, 8)}`,
      homeLocation: 'MCAC',
      ...overrides,
    });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  async function makeShift(overrides: Record<string, any> = {}) {
    const ref = await db.collection('shifts').add({
      isInserviceShift: true,
      status: 'assigned',
      notes: '[Inservice]',
      ...overrides,
    });
    createdShiftIds.push(ref.id);
    return ref.id;
  }

  async function makeCheckin(employeeId: string, checkinTime: string) {
    const ref = await db.collection('checkins').add({ employeeId, checkinTime, sessionId: 'session-x' });
    createdCheckinIds.push(ref.id);
    return ref.id;
  }

  it('rejects a non-supervisor role with 403', async () => {
    const response = await request(app)
      .get('/api/shifts/attendance')
      .set('Cookie', authCookie({ role: 'trainer' }));
    expect(response.status).toBe(403);
  });

  it('flags an assigned past inservice shift with no matching checkin as missed', async () => {
    const employeeId = await makeEmployee();
    const start = moment().subtract(2, 'hours');
    const end = moment().subtract(1, 'hours');
    await makeShift({ employeeId, start: start.toISOString(), end: end.toISOString() });

    const response = await request(app).get('/api/shifts/attendance').set('Cookie', authCookie());

    expect(response.status).toBe(200);
    const row = response.body.find((r: any) => r.employeeId === employeeId);
    expect(row).toBeTruthy();
    expect(row.attended).toBe(false);
  });

  it('does not flag a shift where the employee actually checked in during the window', async () => {
    const employeeId = await makeEmployee();
    const start = moment().subtract(2, 'hours');
    const end = moment().subtract(1, 'hours');
    await makeShift({ employeeId, start: start.toISOString(), end: end.toISOString() });
    await makeCheckin(employeeId, start.clone().add(10, 'minutes').toISOString());

    const response = await request(app).get('/api/shifts/attendance').set('Cookie', authCookie());

    expect(response.status).toBe(200);
    expect(response.body.find((r: any) => r.employeeId === employeeId)).toBeUndefined();
  });

  it('includes attended shifts when onlyMissed=false', async () => {
    const employeeId = await makeEmployee();
    const start = moment().subtract(2, 'hours');
    const end = moment().subtract(1, 'hours');
    await makeShift({ employeeId, start: start.toISOString(), end: end.toISOString() });
    await makeCheckin(employeeId, start.clone().add(10, 'minutes').toISOString());

    const response = await request(app)
      .get('/api/shifts/attendance')
      .query({ onlyMissed: 'false' })
      .set('Cookie', authCookie());

    const row = response.body.find((r: any) => r.employeeId === employeeId);
    expect(row).toBeTruthy();
    expect(row.attended).toBe(true);
  });

  it('ignores a future shift (not yet happened) and an unassigned open shift', async () => {
    const employeeId = await makeEmployee();
    await makeShift({
      employeeId,
      start: moment().add(1, 'day').toISOString(),
      end: moment().add(1, 'day').add(1, 'hour').toISOString(),
    });
    await makeShift({
      employeeId: null,
      status: 'open',
      start: moment().subtract(1, 'day').toISOString(),
      end: moment().subtract(1, 'day').add(1, 'hour').toISOString(),
    });

    const response = await request(app)
      .get('/api/shifts/attendance')
      .query({ onlyMissed: 'false' })
      .set('Cookie', authCookie());

    expect(response.body.find((r: any) => r.employeeId === employeeId)).toBeUndefined();
  });
});
