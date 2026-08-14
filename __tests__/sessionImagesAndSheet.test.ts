export {};
const request = require('supertest');

// Both routes hit R2 to mint signed URLs — stub it so this doesn't require
// live R2 credentials/network (same approach as signInSheetDeletion.test.ts).
jest.mock('../config/r2', () => ({
  r2Client: { send: jest.fn() },
  getBucketName: () => 'test-bucket',
  getSignedSheetImageUrl: jest.fn((key: string) => Promise.resolve(`https://signed.example/${key}`)),
}));

const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// Runs against the local Firestore emulator (see jest.setup.js).
describe('GET /api/sessions/images-batch', () => {
  const createdSessionIds: string[] = [];

  afterEach(async () => {
    for (const id of createdSessionIds.splice(0)) await db.collection('sessions').doc(id).delete();
  });

  async function makeSession(overrides: Record<string, any> = {}) {
    const ref = await db.collection('sessions').add({
      date: '2026-06-01',
      location: 'MCAC',
      status: 'completed',
      sheetImageKeys: [],
      ...overrides,
    });
    createdSessionIds.push(ref.id);
    return ref.id;
  }

  it('returns each session\'s signed URLs keyed by session ID, in one request', async () => {
    const sessionA = await makeSession({ sheetImageKeys: ['a-1.jpg', 'a-2.jpg'] });
    const sessionB = await makeSession({ sheetImageKeys: ['b-1.jpg'] });

    const response = await request(app)
      .get('/api/sessions/images-batch')
      .query({ sessionIds: `${sessionA},${sessionB}` })
      .set('Cookie', authCookie());

    expect(response.status).toBe(200);
    expect(response.body[sessionA]).toEqual([
      'https://signed.example/a-1.jpg',
      'https://signed.example/a-2.jpg',
    ]);
    expect(response.body[sessionB]).toEqual(['https://signed.example/b-1.jpg']);
  });

  it('returns an empty array for a session with no photos, without erroring the whole batch', async () => {
    const sessionA = await makeSession({ sheetImageKeys: ['a-1.jpg'] });
    const sessionEmpty = await makeSession({ sheetImageKeys: [] });

    const response = await request(app)
      .get('/api/sessions/images-batch')
      .query({ sessionIds: `${sessionA},${sessionEmpty}` })
      .set('Cookie', authCookie());

    expect(response.status).toBe(200);
    expect(response.body[sessionEmpty]).toEqual([]);
  });

  it('returns an empty object when sessionIds is missing/empty, without touching Firestore', async () => {
    const response = await request(app)
      .get('/api/sessions/images-batch')
      .set('Cookie', authCookie());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
  });

  it('rejects an unauthenticated caller', async () => {
    const response = await request(app).get('/api/sessions/images-batch').query({ sessionIds: 'whatever' });
    expect(response.status).toBe(401);
  });
});

describe('GET /api/sessions/:sessionId/inservice-sheet — isLegacyFormat', () => {
  const createdSessionIds: string[] = [];

  afterEach(async () => {
    for (const id of createdSessionIds.splice(0)) await db.collection('sessions').doc(id).delete();
  });

  async function makeSession(inserviceSheetKey: string | null) {
    const ref = await db.collection('sessions').add({
      date: '2026-06-01',
      location: 'MCAC',
      status: 'completed',
      inserviceSheetKey,
    });
    createdSessionIds.push(ref.id);
    return ref.id;
  }

  it('flags a legacy .docx sheet as isLegacyFormat, with a .docx download filename', async () => {
    const sessionId = await makeSession('inservice-sheets/2026/06/old-session.docx');

    const response = await request(app)
      .get(`/api/sessions/${sessionId}/inservice-sheet`)
      .set('Cookie', authCookie());

    expect(response.status).toBe(200);
    expect(response.body.isLegacyFormat).toBe(true);
    expect(response.body.downloadUrl).toMatch(/\.docx/);
  });

  it('does not flag a .pdf sheet as legacy, with a .pdf download filename', async () => {
    const sessionId = await makeSession('inservice-sheets/2026/06/new-session.pdf');

    const response = await request(app)
      .get(`/api/sessions/${sessionId}/inservice-sheet`)
      .set('Cookie', authCookie());

    expect(response.status).toBe(200);
    expect(response.body.isLegacyFormat).toBe(false);
    expect(response.body.downloadUrl).toMatch(/\.pdf/);
  });
});
