export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// Runs against the local Firestore emulator (see jest.setup.js). Mocks
// global.fetch the same way __tests__/messagingService.test.ts does, so no
// real Resend call goes out.
describe('POST /api/compliance/letter/:employeeId/send', () => {
  const createdEmployeeIds: string[] = [];
  const originalFetch = global.fetch;

  afterEach(async () => {
    global.fetch = originalFetch;
    for (const id of createdEmployeeIds.splice(0)) await db.collection('employees').doc(id).delete();
  });

  async function makeEmployee(overrides: Record<string, any> = {}) {
    const ref = await db.collection('employees').add({
      name: 'Jamie Rivera',
      firstName: 'Jamie',
      lastName: 'Rivera',
      email: 'jamie.rivera@example.com',
      homeLocation: 'MCAC',
      isActive: true,
      certifications: [{ type: 'Lifeguarding', expirationDate: '2099-01-01' }],
      ...overrides,
    });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  it('emails the generated letter as a Word attachment', async () => {
    const employeeId = await makeEmployee();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ id: 'resend-id' }),
    });
    global.fetch = fetchMock as any;

    const response = await request(app)
      .post(`/api/compliance/letter/${employeeId}/send`)
      .set('Cookie', authCookie());

    expect(response.status).toBe(200);
    expect(response.body.message).toContain('Jamie Rivera');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({ method: 'POST' })
    );
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(sentBody.to).toEqual(['jamie.rivera@example.com']);
    expect(sentBody.attachments).toHaveLength(1);
    expect(sentBody.attachments[0].filename).toContain('Jamie Rivera');
    expect(typeof sentBody.attachments[0].content).toBe('string');
  });

  it('400s when the employee has no email on file', async () => {
    const employeeId = await makeEmployee({ email: '' });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const response = await request(app)
      .post(`/api/compliance/letter/${employeeId}/send`)
      .set('Cookie', authCookie());

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s for an employee that does not exist', async () => {
    const response = await request(app)
      .post('/api/compliance/letter/does-not-exist/send')
      .set('Cookie', authCookie());

    expect(response.status).toBe(404);
  });

  it('rejects a trainer (supervisor-only route)', async () => {
    const employeeId = await makeEmployee();
    const response = await request(app)
      .post(`/api/compliance/letter/${employeeId}/send`)
      .set('Cookie', authCookie({ role: 'trainer' }));

    expect(response.status).toBe(403);
  });
});
