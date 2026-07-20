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

describe('Trainers API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/trainers', () => {
    it('should return an empty array when no trainers exist', async () => {
      const mockGet = jest.fn().mockResolvedValue({ forEach: jest.fn() });
      const mockWhere = jest.fn().mockReturnValue({ get: mockGet });
      (db.collection as jest.Mock).mockReturnValue({ where: mockWhere, get: mockGet });

      const response = await request(app).get('/api/trainers').set('Cookie', authCookie());
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    it('should return all trainers when they exist', async () => {
      const mockDocs = [{ id: 'test-id', data: () => ({ name: 'John Doe', email: 'john@example.com' }) }];
      const mockGet = jest.fn().mockResolvedValue({ forEach: (cb: any) => mockDocs.forEach(cb) });
      const mockWhere = jest.fn().mockReturnValue({ get: mockGet });
      (db.collection as jest.Mock).mockReturnValue({ where: mockWhere, get: mockGet });

      const response = await request(app).get('/api/trainers').set('Cookie', authCookie());
      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        { id: 'test-id', name: 'John Doe', email: 'john@example.com' }
      ]);
    });
  });

  describe('POST /api/trainers', () => {
    it('should create a new trainer', async () => {
      const mockAdd = jest.fn().mockResolvedValue({ id: 'new-id' });
      (db.collection as jest.Mock).mockReturnValue({ add: mockAdd });

      const response = await request(app)
        .post('/api/trainers')
        .set('Cookie', authCookie())
        .send({ name: 'John Doe', email: 'john@test.com' });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id', 'new-id');
      expect(response.body.trainer).toHaveProperty('name', 'John Doe');
      expect(mockAdd).toHaveBeenCalled();
    });

    it('should return 400 when missing required fields (Zod validation)', async () => {
      const response = await request(app)
        .post('/api/trainers')
        .set('Cookie', authCookie())
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.details[0].message).toBe('Trainer name is required');
    });
  });

  describe('GET /api/trainers/:id', () => {
    it('should return a specific trainer', async () => {
      const mockDocGet = jest.fn().mockResolvedValue({ exists: true, id: 'test-id', data: () => ({ name: 'John Doe' }) });
      const mockDoc = jest.fn().mockReturnValue({ get: mockDocGet });
      (db.collection as jest.Mock).mockReturnValue({ doc: mockDoc });

      const response = await request(app).get('/api/trainers/test-id').set('Cookie', authCookie());
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ id: 'test-id', name: 'John Doe' });
    });
  });
}); 