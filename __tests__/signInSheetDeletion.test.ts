export {};
const request = require('supertest');

// Both delete routes hit R2 — stub the client so this doesn't require live
// R2 credentials/network (same approach as inserviceSheetSubmission.test.ts).
const sendMock = jest.fn().mockResolvedValue({});
jest.mock('../config/r2', () => ({
  r2Client: { send: (...args: any[]) => sendMock(...args) },
  getBucketName: () => 'test-bucket',
  getSignedSheetImageUrl: jest.fn(),
}));

const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

// Runs against the local Firestore emulator (see jest.setup.js). Deleting
// sign-in sheets is bundled into Senior Supervisor and up (see utils/roles.ts).
describe('DELETE sign-in sheets — role-based permission', () => {
  const createdEmployeeIds: string[] = [];
  const createdSessionIds: string[] = [];

  afterEach(async () => {
    sendMock.mockClear();
    for (const id of createdEmployeeIds.splice(0)) await db.collection('employees').doc(id).delete();
    for (const id of createdSessionIds.splice(0)) await db.collection('sessions').doc(id).delete();
  });

  async function makeActor(role: string) {
    const ref = await db.collection('employees').add({ name: 'Test Actor', role });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  async function makeSession(overrides: Record<string, any> = {}) {
    const ref = await db.collection('sessions').add({
      date: '2026-06-01',
      location: 'MCAC',
      status: 'completed',
      topics: ['CPR'],
      trainer: ['trainer-1'],
      sheetImageKeys: ['signin-sheets/2026/06/photo-1.jpg', 'signin-sheets/2026/06/photo-2.jpg'],
      sheetImageHashes: ['hash-1', 'hash-2'],
      inserviceSheetKey: 'inservice-sheets/2026/06/session-x.pdf',
      ...overrides,
    });
    createdSessionIds.push(ref.id);
    return ref.id;
  }

  describe('DELETE /api/sessions/:sessionId/images/:index', () => {
    it('rejects a plain Supervisor — this is Senior Supervisor and up only', async () => {
      const employeeId = await makeActor('supervisor');
      const sessionId = await makeSession();

      const response = await request(app)
        .delete(`/api/sessions/${sessionId}/images/0`)
        .set('Cookie', authCookie({ role: 'supervisor', employeeId }));

      expect(response.status).toBe(403);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('deletes the photo at the given index and keeps the arrays aligned', async () => {
      const employeeId = await makeActor('seniorSupervisor');
      const sessionId = await makeSession();

      const response = await request(app)
        .delete(`/api/sessions/${sessionId}/images/0`)
        .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId }));

      expect(response.status).toBe(200);
      expect(sendMock).toHaveBeenCalledTimes(1);
      const deleteCommand = sendMock.mock.calls[0][0];
      expect(deleteCommand.input.Key).toBe('signin-sheets/2026/06/photo-1.jpg');

      const saved = await db.collection('sessions').doc(sessionId).get();
      expect(saved.data()?.sheetImageKeys).toEqual(['signin-sheets/2026/06/photo-2.jpg']);
      expect(saved.data()?.sheetImageHashes).toEqual(['hash-2']);
    });

    it('404s for an out-of-range index', async () => {
      const employeeId = await makeActor('seniorSupervisor');
      const sessionId = await makeSession();

      const response = await request(app)
        .delete(`/api/sessions/${sessionId}/images/5`)
        .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId }));

      expect(response.status).toBe(404);
      expect(sendMock).not.toHaveBeenCalled();
    });

    // Regression: the record and the file are cleaned up independently — a
    // storage-side failure must not leave the session stuck showing a photo
    // that can never be removed.
    it('still clears the record even when the R2 delete fails', async () => {
      const employeeId = await makeActor('seniorSupervisor');
      const sessionId = await makeSession();
      sendMock.mockRejectedValueOnce(new Error('R2 is having a bad day'));

      const response = await request(app)
        .delete(`/api/sessions/${sessionId}/images/0`)
        .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId }));

      expect(response.status).toBe(200);
      const saved = await db.collection('sessions').doc(sessionId).get();
      expect(saved.data()?.sheetImageKeys).toEqual(['signin-sheets/2026/06/photo-2.jpg']);
    });

    it('rejects a trainer (supervisor-only route)', async () => {
      const sessionId = await makeSession();
      const response = await request(app)
        .delete(`/api/sessions/${sessionId}/images/0`)
        .set('Cookie', authCookie({ role: 'trainer' }));

      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/sessions/:sessionId/inservice-sheet', () => {
    it('rejects a plain Supervisor — this is Senior Supervisor and up only', async () => {
      const employeeId = await makeActor('supervisor');
      const sessionId = await makeSession();

      const response = await request(app)
        .delete(`/api/sessions/${sessionId}/inservice-sheet`)
        .set('Cookie', authCookie({ role: 'supervisor', employeeId }));

      expect(response.status).toBe(403);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('deletes the R2 object and clears inserviceSheetKey', async () => {
      const employeeId = await makeActor('seniorSupervisor');
      const sessionId = await makeSession();

      const response = await request(app)
        .delete(`/api/sessions/${sessionId}/inservice-sheet`)
        .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId }));

      expect(response.status).toBe(200);
      expect(sendMock).toHaveBeenCalledTimes(1);
      const deleteCommand = sendMock.mock.calls[0][0];
      expect(deleteCommand.input.Key).toBe('inservice-sheets/2026/06/session-x.pdf');

      const saved = await db.collection('sessions').doc(sessionId).get();
      expect(saved.data()?.inserviceSheetKey).toBeNull();
    });

    it('404s when no sheet has been generated for this session', async () => {
      const employeeId = await makeActor('seniorSupervisor');
      const sessionId = await makeSession({ inserviceSheetKey: null });

      const response = await request(app)
        .delete(`/api/sessions/${sessionId}/inservice-sheet`)
        .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId }));

      expect(response.status).toBe(404);
    });

    // Regression: the record and the file are cleaned up independently — a
    // storage-side failure (e.g. the object was already removed some other
    // way) must not leave the session stuck showing a sheet that can never
    // be cleared.
    it('still clears the record even when the R2 delete fails', async () => {
      const employeeId = await makeActor('seniorSupervisor');
      const sessionId = await makeSession();
      sendMock.mockRejectedValueOnce(new Error('R2 is having a bad day'));

      const response = await request(app)
        .delete(`/api/sessions/${sessionId}/inservice-sheet`)
        .set('Cookie', authCookie({ role: 'seniorSupervisor', employeeId }));

      expect(response.status).toBe(200);
      const saved = await db.collection('sessions').doc(sessionId).get();
      expect(saved.data()?.inserviceSheetKey).toBeNull();
    });
  });
});
