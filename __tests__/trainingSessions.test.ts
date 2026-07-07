import request from 'supertest';
import app from '../app';
import { db } from '../config/firebase';

// Mock Firebase
jest.mock('../config/firebase', () => ({
  db: {
    collection: jest.fn(),
  },
}));

describe('Training Sessions API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/sessions', () => {
    it('should return an empty array when no sessions exist', async () => {
      const mockGet = jest.fn().mockResolvedValue({ forEach: jest.fn() });
      (db.collection as jest.Mock).mockReturnValue({ get: mockGet });

      const response = await request(app).get('/api/sessions');
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });
  });

  describe('POST /api/sessions', () => {
    it('should return 400 when session body is invalid (Zod validation)', async () => {
      const response = await request(app)
        .post('/api/sessions')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      // Should flag missing date, location, etc.
      expect(response.body.error.details.length).toBeGreaterThan(0);
    });
    
    it('should create a new session', async () => {
      const mockAdd = jest.fn().mockResolvedValue({ id: 'new-id' });
      const mockDocGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({ name: 'Test Trainer' }) });
      const mockDoc = jest.fn().mockReturnValue({ get: mockDocGet });
      (db.collection as jest.Mock).mockImplementation((coll) => {
        if (coll === 'trainers') return { doc: mockDoc };
        return { add: mockAdd };
      });

      const response = await request(app)
        .post('/api/sessions')
        .send({
          date: '2025-01-01',
          location: 'Test Location',
          length: 60,
          topic: 'Zod Validation',
          trainer: 'trainer-1',
          trainees: []
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('sessionId', 'new-id');
    });
  });

  describe('POST /api/training-sessions', () => {
    it('should create a shared active session so the UI list refreshes', async () => {
      const mockSharedSessionAdd = jest.fn().mockResolvedValue({ id: 'shared-session-id' });
      const mockLegacySessionAdd = jest.fn().mockResolvedValue({ id: 'legacy-session-id' });

      (db.collection as jest.Mock).mockImplementation((coll) => {
        if (coll === 'sessions') {
          return { add: mockSharedSessionAdd };
        }

        if (coll === 'trainingSessions') {
          return { add: mockLegacySessionAdd };
        }

        return { add: jest.fn() };
      });

      const response = await request(app)
        .post('/api/training-sessions')
        .send({
          date: '2025-01-02',
          location: 'MCAC',
          length: 90,
          topic: 'Active Session Sync',
          trainer: 'trainer-1',
          trainees: []
        });

      expect(response.status).toBe(201);
      expect(mockSharedSessionAdd).toHaveBeenCalledTimes(1);
      expect(response.body).toHaveProperty('sessionId', 'shared-session-id');
    });
  });

  describe('PUT /api/sessions/:sessionId', () => {
    it('should return the updated session data after manual employee and trainer changes', async () => {
      const mockUpdate = jest.fn().mockResolvedValue(undefined);
      const mockGet = jest.fn().mockResolvedValue({
        exists: true,
        data: () => ({ topic: 'Existing Topic', trainer: ['trainer-1'], trainees: [] })
      });
      const mockDoc = jest.fn().mockReturnValue({ get: mockGet, update: mockUpdate });
      (db.collection as jest.Mock).mockImplementation(() => ({ doc: mockDoc }));

      const response = await request(app)
        .put('/api/sessions/session-123')
        .send({
          trainees: ['employee-1'],
          trainer: ['trainer-1', 'trainer-2']
        });

      expect(response.status).toBe(200);
      expect(response.body.session.trainees).toEqual(['employee-1']);
      expect(response.body.session.trainer).toEqual(['trainer-1', 'trainer-2']);
      expect(mockUpdate).toHaveBeenCalled();
    });
  });
}); 