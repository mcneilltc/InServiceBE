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
}); 