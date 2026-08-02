import request from 'supertest';
import crypto from 'crypto';
import app from '../app';

jest.mock('../services/wheniworkService', () => ({
  upsertShiftFromWebhookEvent: jest.fn().mockResolvedValue('some-doc-id'),
}));

const { upsertShiftFromWebhookEvent } = require('../services/wheniworkService');

const WEBHOOK_SECRET = 'test-webhook-secret';

function sign(payload: any): string {
  const raw = JSON.stringify(payload);
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
}

// Skipped: routes/wheniwork.ts is commented out of app.ts (When I Work
// integration pulled from production for now — see app.ts). Re-enable this
// suite together with that route mount.
describe.skip('POST /api/wheniwork/webhook', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, WHENIWORK_WEBHOOK_SECRET: WEBHOOK_SECRET };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  const payload = { event: 'shift.created', shift: { id: 'wiw-shift-1', notes: '[Inservice]' } };

  it('accepts a request with a valid signature and processes the event', async () => {
    const signature = sign(payload);

    const response = await request(app)
      .post('/api/wheniwork/webhook')
      .set('x-wheniwork-signature', signature)
      .send(payload);

    expect(response.status).toBe(200);
    expect(upsertShiftFromWebhookEvent).toHaveBeenCalledWith('shift.created', payload.shift);
  });

  it('rejects a request with an invalid signature and does not process the event', async () => {
    const response = await request(app)
      .post('/api/wheniwork/webhook')
      .set('x-wheniwork-signature', 'deadbeef'.repeat(8))
      .send(payload);

    expect(response.status).toBe(401);
    expect(upsertShiftFromWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects a request with a missing signature header', async () => {
    const response = await request(app).post('/api/wheniwork/webhook').send(payload);

    expect(response.status).toBe(401);
    expect(upsertShiftFromWebhookEvent).not.toHaveBeenCalled();
  });

  it('is idempotent — processing the same event twice results in two delegate calls, not an error', async () => {
    const signature = sign(payload);

    await request(app).post('/api/wheniwork/webhook').set('x-wheniwork-signature', signature).send(payload);
    const secondResponse = await request(app)
      .post('/api/wheniwork/webhook')
      .set('x-wheniwork-signature', signature)
      .send(payload);

    expect(secondResponse.status).toBe(200);
    expect(upsertShiftFromWebhookEvent).toHaveBeenCalledTimes(2);
  });
});
