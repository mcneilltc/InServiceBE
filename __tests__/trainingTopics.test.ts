import request from 'supertest';
import app from '../app';
import { db } from '../config/firebase';
import { authCookie } from './testHelpers';

// Mock Firebase
jest.mock('../config/firebase', () => ({
  db: {
    collection: jest.fn(),
  },
}));

describe('Training Topics API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/training-topics', () => {
    it('should return an empty array when no topics exist', async () => {
      const mockGet = jest.fn().mockResolvedValue({ forEach: jest.fn() });
      (db.collection as jest.Mock).mockReturnValue({ get: mockGet });

      const response = await request(app).get('/api/training-topics').set('Cookie', authCookie());
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    it('should return all topics when they exist', async () => {
      const mockDocs = [{ id: 'test-id', data: () => ({ name: 'JavaScript Basics' }) }];
      const mockGet = jest.fn().mockResolvedValue({ forEach: (cb: any) => mockDocs.forEach(cb) });
      (db.collection as jest.Mock).mockReturnValue({ get: mockGet });

      const response = await request(app).get('/api/training-topics').set('Cookie', authCookie());
      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        { id: 'test-id', name: 'JavaScript Basics' }
      ]);
    });
  });

  describe('POST /api/training-topics', () => {
    it('should create a new training topic', async () => {
      const mockAdd = jest.fn().mockResolvedValue({ id: 'new-id' });
      (db.collection as jest.Mock).mockReturnValue({ add: mockAdd });

      const response = await request(app)
        .post('/api/training-topics')
        .set('Cookie', authCookie())
        .send({ topicName: 'JavaScript Basics' });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id', 'new-id');
      expect(response.body.topic).toHaveProperty('name', 'JavaScript Basics');
    });

    it('should return 400 when topicName is missing (Zod validation)', async () => {
      const response = await request(app)
        .post('/api/training-topics')
        .set('Cookie', authCookie())
        .send({ topicName: '' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.details[0].message).toBe('Topic name is required');
    });
  });
}); 