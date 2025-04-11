const request = require('supertest');
const app = require('../app'); // We'll need to modify app.js to export the app
const data = require('../data');

describe('Trainers API', () => {
  beforeEach(() => {
    // Clear the trainers data before each test
    data.trainers = {};
  });

  describe('GET /api/trainers', () => {
    it('should return an empty array when no trainers exist', async () => {
      const response = await request(app).get('/api/trainers');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });

    it('should return all trainers when they exist', async () => {
      // Add a test trainer
      const trainerId = 'test-id';
      data.trainers[trainerId] = 'John Doe';

      const response = await request(app).get('/api/trainers');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        [trainerId]: 'John Doe'
      });
    });
  });

  describe('POST /api/trainers', () => {
    it('should create a new trainer', async () => {
      const response = await request(app)
        .post('/api/trainers')
        .send({ trainerName: 'John Doe' });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('trainerId');
      expect(response.body).toHaveProperty('trainerName', 'John Doe');
      expect(data.trainers[response.body.trainerId]).toBe('John Doe');
    });

    it('should return 400 when trainerName is missing', async () => {
      const response = await request(app)
        .post('/api/trainers')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ message: 'Trainer name is required' });
    });
  });

  describe('GET /api/trainers/:id', () => {
    it('should return a specific trainer', async () => {
      const trainerId = 'test-id';
      data.trainers[trainerId] = 'John Doe';

      const response = await request(app).get(`/api/trainers/${trainerId}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: `Get trainer with ID: ${trainerId}` });
    });
  });
}); 