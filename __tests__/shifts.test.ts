import request from 'supertest';
import app from '../app';
import { db } from '../config/firebase';
import { authCookie, employeeAuthCookie } from './testHelpers';

jest.mock('../config/firebase', () => ({
  db: {
    collection: jest.fn(),
    runTransaction: jest.fn(),
  },
}));

jest.mock('../services/wheniworkClient', () => ({
  assignShiftToUser: jest.fn().mockResolvedValue({ ok: true }),
}));

const { assignShiftToUser } = require('../services/wheniworkClient');

// Skipped: routes/shifts.ts is commented out of app.ts (When I Work
// integration pulled from production for now — see app.ts). Re-enable these
// suites together with that route mount.
describe.skip('GET /api/shifts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects a non-employee role (e.g. supervisor) with 403', async () => {
    const mockGet = jest.fn();
    (db.collection as jest.Mock).mockReturnValue({
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      get: mockGet,
    });

    const response = await request(app).get('/api/shifts').set('Cookie', authCookie());
    expect(response.status).toBe(403);
  });

  it('returns 401 with no session cookie', async () => {
    const response = await request(app).get('/api/shifts');
    expect(response.status).toBe(401);
  });

  it('returns only open, future, inservice-tagged shifts for an employee', async () => {
    const docs = [
      { id: 'shift-1', data: () => ({ isInserviceShift: true, status: 'open', start: '2026-08-01T09:00:00Z' }) },
    ];
    const chain: any = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ docs }),
    };
    (db.collection as jest.Mock).mockReturnValue(chain);

    const response = await request(app).get('/api/shifts').set('Cookie', employeeAuthCookie());

    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ id: 'shift-1', isInserviceShift: true, status: 'open', start: '2026-08-01T09:00:00Z' }]);
    expect(chain.where).toHaveBeenCalledWith('isInserviceShift', '==', true);
    expect(chain.where).toHaveBeenCalledWith('status', '==', 'open');
  });
});

describe.skip('POST /api/shifts/:id/pickup', () => {
  // A tiny in-memory Firestore-transaction fake: runTransaction callbacks are
  // queued and run strictly in call order (mirroring the atomicity guarantee
  // real Firestore transactions provide), so two "concurrent" pickup
  // requests against the same shift deterministically resolve to exactly
  // one winner — enough to exercise pickUpShift's double-booking guard
  // without needing to simulate Firestore's real contention/retry mechanics.
  let shiftsStore: Record<string, any>;
  let transactionQueue: Promise<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    shiftsStore = {
      'shift-1': { status: 'open', wheniworkShiftId: 'wiw-shift-1', employeeId: null },
    };
    transactionQueue = Promise.resolve();

    (db.collection as jest.Mock).mockImplementation((name: string) => {
      if (name === 'employees') {
        return {
          doc: jest.fn((id: string) => ({
            get: jest.fn().mockResolvedValue(
              id === 'employee-unlinked'
                ? { exists: true, data: () => ({ wheniworkUserId: null }) }
                : { exists: true, data: () => ({ wheniworkUserId: 'wiw-user-1' }) }
            ),
          })),
        };
      }
      if (name === 'shifts') {
        return {
          doc: jest.fn((id: string) => ({
            id,
            // Used by pickUpShift's compensating-rollback path, which calls
            // shiftRef.update() directly (outside the transaction) if When I
            // Work rejects the assignment after the local claim committed.
            update: jest.fn((data: any) => {
              shiftsStore[id] = { ...shiftsStore[id], ...data };
              return Promise.resolve();
            }),
          })),
        };
      }
      throw new Error(`Unexpected collection: ${name}`);
    });

    (db.runTransaction as jest.Mock).mockImplementation((cb: any) => {
      const run = transactionQueue.then(() =>
        cb({
          get: async (ref: any) => ({ exists: !!shiftsStore[ref.id], data: () => ({ ...shiftsStore[ref.id] }) }),
          update: (ref: any, data: any) => {
            shiftsStore[ref.id] = { ...shiftsStore[ref.id], ...data };
          },
        })
      );
      transactionQueue = run.catch(() => {});
      return run;
    });
  });

  it('lets an employee pick up an open shift', async () => {
    const response = await request(app).post('/api/shifts/shift-1/pickup').set('Cookie', employeeAuthCookie());

    expect(response.status).toBe(200);
    expect(shiftsStore['shift-1'].status).toBe('assigned');
    expect(assignShiftToUser).toHaveBeenCalledWith('wiw-shift-1', 'wiw-user-1');
  });

  it('rejects a second, concurrent pickup of the same shift with 409', async () => {
    const [first, second] = await Promise.all([
      request(app).post('/api/shifts/shift-1/pickup').set('Cookie', employeeAuthCookie()),
      request(app).post('/api/shifts/shift-1/pickup').set('Cookie', employeeAuthCookie({ employeeId: 'employee-2' })),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(shiftsStore['shift-1'].status).toBe('assigned');
  });

  it('returns 409 when the employee has no linked wheniworkUserId', async () => {
    const response = await request(app)
      .post('/api/shifts/shift-1/pickup')
      .set('Cookie', employeeAuthCookie({ employeeId: 'employee-unlinked' }));

    expect(response.status).toBe(409);
    expect(shiftsStore['shift-1'].status).toBe('open');
  });

  it('reverts the local claim and returns 502 if When I Work rejects the assignment', async () => {
    (assignShiftToUser as jest.Mock).mockRejectedValueOnce(new Error('WIW rejected'));

    const response = await request(app).post('/api/shifts/shift-1/pickup').set('Cookie', employeeAuthCookie());

    expect(response.status).toBe(502);
    expect(shiftsStore['shift-1'].status).toBe('open');
    expect(shiftsStore['shift-1'].employeeId).toBeNull();
  });
});
