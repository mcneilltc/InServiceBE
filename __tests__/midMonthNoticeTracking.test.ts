export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// POST /api/compliance/notify-midmonth now records when each employee's
// reminder was actually sent, so the compliance letter can cite a real date
// (see complianceLetterService.ts's contact-note fallback vs. cited-date tests).
describe('POST /api/compliance/notify-midmonth — records lastMidMonthNoticeSentAt', () => {
  const createdEmployeeIds: string[] = [];
  const originalFetch = global.fetch;

  afterEach(async () => {
    global.fetch = originalFetch;
    for (const id of createdEmployeeIds.splice(0)) await db.collection('employees').doc(id).delete();
  });

  async function makeEmployee(overrides: Record<string, any> = {}) {
    const ref = await db.collection('employees').add({
      name: 'Under Threshold',
      email: 'under-threshold@example.com',
      homeLocation: 'MCAC',
      isActive: true,
      certifications: [{ type: 'Lifeguarding', expirationDate: '2099-01-01' }],
      ...overrides,
    });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  it('stamps lastMidMonthNoticeSentAt only when the email send succeeds', async () => {
    const employeeId = await makeEmployee();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ id: 'resend-id' }),
    });
    global.fetch = fetchMock as any;

    const response = await request(app)
      .post('/api/compliance/notify-midmonth')
      .set('Cookie', authCookie());

    expect(response.status).toBe(200);
    const doc = await db.collection('employees').doc(employeeId).get();
    expect(doc.data().lastMidMonthNoticeSentAt).toBeTruthy();
  });

  it('does not stamp the field when the email send fails', async () => {
    const employeeId = await makeEmployee();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: jest.fn().mockResolvedValue({}),
    });
    global.fetch = fetchMock as any;

    await request(app).post('/api/compliance/notify-midmonth').set('Cookie', authCookie());

    const doc = await db.collection('employees').doc(employeeId).get();
    expect(doc.data().lastMidMonthNoticeSentAt).toBeUndefined();
  });
});
