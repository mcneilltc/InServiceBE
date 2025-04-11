const request = require('supertest');
const app = require('../app');
const data = require('../data');

describe('Training Topics API', () => {
  beforeEach(() => {
    // Clear the training topics data before each test
    data.trainingTopics = {};
  });

  describe('GET /api/training-topics', () => {
    it('should return an empty object when no topics exist', async () => {
      const response = await request(app).get('/api/training-topics');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });

    it('should return all topics when they exist', async () => {
      // Add a test topic
      const topicId = 'test-id';
      data.trainingTopics[topicId] = 'JavaScript Basics';

      const response = await request(app).get('/api/training-topics');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        [topicId]: 'JavaScript Basics'
      });
    });
  });

  describe('POST /api/training-topics', () => {
    it('should create a new training topic', async () => {
      const response = await request(app)
        .post('/api/training-topics')
        .send({ topicName: 'JavaScript Basics' });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('topicId');
      expect(response.body).toHaveProperty('topicName', 'JavaScript Basics');
      expect(data.trainingTopics[response.body.topicId]).toBe('JavaScript Basics');
    });

    it('should return 400 when topicName is missing', async () => {
      const response = await request(app)
        .post('/api/training-topics')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ message: 'Topic name is required' });
    });
  });
}); 