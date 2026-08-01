import { db } from '../config/firebase';

jest.mock('../config/firebase', () => ({
  db: {
    collection: jest.fn(),
  },
}));

// wheniworkService imports assignShiftToUser from wheniworkClient, which
// isn't exercised by these tests (isInserviceNotes/upsertShiftFromWebhookEvent
// only) — mock it out so a real fetch is never attempted.
jest.mock('../services/wheniworkClient', () => ({
  assignShiftToUser: jest.fn(),
}));

import { isInserviceNotes, upsertShiftFromWebhookEvent } from '../services/wheniworkService';

describe('isInserviceNotes', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.WHENIWORK_INSERVICE_KEYWORD;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('matches the default keyword case-insensitively', () => {
    expect(isInserviceNotes('Please cover — [inservice] training shift')).toBe(true);
    expect(isInserviceNotes('[INSERVICE] mandatory')).toBe(true);
  });

  it('returns false when the keyword is absent', () => {
    expect(isInserviceNotes('Just a regular shift, come in at 9am')).toBe(false);
  });

  it('returns false for notes that only share a substring with the keyword', () => {
    // "inservicing" contains "inservice" but not the bracketed keyword itself
    expect(isInserviceNotes('inservicing the machines today')).toBe(false);
  });

  it('returns false for null/undefined/empty notes', () => {
    expect(isInserviceNotes(null)).toBe(false);
    expect(isInserviceNotes(undefined)).toBe(false);
    expect(isInserviceNotes('')).toBe(false);
  });

  it('respects a configured WHENIWORK_INSERVICE_KEYWORD override', () => {
    process.env.WHENIWORK_INSERVICE_KEYWORD = 'COVERAGE-TAG';
    jest.resetModules();
    const { isInserviceNotes: isInserviceNotesReloaded } = require('../services/wheniworkService');
    expect(isInserviceNotesReloaded('please pick up — COVERAGE-TAG')).toBe(true);
    expect(isInserviceNotesReloaded('[inservice] old-style tag')).toBe(false);
  });
});

describe('upsertShiftFromWebhookEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Builds one stable mock object per collection name and returns it on
  // every call — upsertShiftFromWebhookEvent calls db.collection('shifts')
  // twice (once to check for an existing doc, once to add/update), and both
  // calls must resolve to the same `add`/`where` mock functions for
  // assertions against them to see the actual invocation.
  function mockCollections({ existingShiftDoc = null as any, employeeMatchDoc = null as any } = {}) {
    const shiftsCollection = {
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue(
            existingShiftDoc ? { empty: false, docs: [existingShiftDoc] } : { empty: true, docs: [] }
          ),
        }),
      }),
      add: jest.fn().mockResolvedValue({ id: 'new-shift-doc-id' }),
    };
    const employeesCollection = {
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue(
            employeeMatchDoc ? { empty: false, docs: [employeeMatchDoc] } : { empty: true, docs: [] }
          ),
        }),
      }),
    };

    (db.collection as jest.Mock).mockImplementation((name: string) => {
      if (name === 'shifts') return shiftsCollection;
      if (name === 'employees') return employeesCollection;
      throw new Error(`Unexpected collection: ${name}`);
    });

    return { shiftsCollection, employeesCollection };
  }

  it('creates a new local shift doc for a first-time shift event', async () => {
    const { shiftsCollection } = mockCollections();

    const id = await upsertShiftFromWebhookEvent('shift.created', {
      id: 'wiw-shift-1',
      user_id: null,
      notes: '[Inservice] cover the front desk',
      start_time: '2026-08-01T09:00:00Z',
      end_time: '2026-08-01T17:00:00Z',
    });

    expect(id).toBe('new-shift-doc-id');
    expect(shiftsCollection.add).toHaveBeenCalledWith(
      expect.objectContaining({
        wheniworkShiftId: 'wiw-shift-1',
        isInserviceShift: true,
        status: 'open',
      })
    );
  });

  it('upserts (updates) an existing local shift doc on a repeat event, staying idempotent', async () => {
    const mockUpdate = jest.fn().mockResolvedValue(undefined);
    const existingShiftDoc = { id: 'existing-doc-id', ref: { update: mockUpdate }, data: () => ({}) };
    mockCollections({ existingShiftDoc });

    const id = await upsertShiftFromWebhookEvent('shift.updated', {
      id: 'wiw-shift-1',
      user_id: 'wiw-user-9',
      notes: '[Inservice] cover the front desk',
      start_time: '2026-08-01T09:00:00Z',
      end_time: '2026-08-01T17:00:00Z',
    });

    expect(id).toBe('existing-doc-id');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ wheniworkShiftId: 'wiw-shift-1', status: 'assigned' })
    );
  });

  it('marks status deleted on a delete event instead of removing the doc', async () => {
    const mockUpdate = jest.fn().mockResolvedValue(undefined);
    const existingShiftDoc = { id: 'existing-doc-id', ref: { update: mockUpdate }, data: () => ({}) };
    mockCollections({ existingShiftDoc });

    const id = await upsertShiftFromWebhookEvent('shift.deleted', { id: 'wiw-shift-1' });

    expect(id).toBe('existing-doc-id');
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'deleted' }));
  });

  it('is a no-op when a delete event references a shift with no local doc', async () => {
    mockCollections();
    const id = await upsertShiftFromWebhookEvent('shift.deleted', { id: 'never-synced' });
    expect(id).toBeNull();
  });
});
