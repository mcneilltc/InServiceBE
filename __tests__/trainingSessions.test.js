const request = require('supertest');
const app = require('../app');
const data = require('../data');

describe('Training Sessions API', () => {
  beforeEach(() => {
    // Clear the data before each test
    data.employees = {};
  });

  describe('GET /api/training-sessions', () => {
    it('should return an empty array when no sessions exist', async () => {
      const response = await request(app).get('/api/training-sessions');
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    it('should return all sessions in the correct format', async () => {
      // Add a test employee with a training session
      const employeeId = 'emp-1';
      const sessionId = 'session-1';
      data.employees[employeeId] = {
        name: 'John Doe',
        trainingSessions: {
          [sessionId]: {
            topic: 'JavaScript Basics',
            trainer: 'Jane Smith',
            date: '2024-03-27',
            trainees: ['emp-1', 'emp-2', 'emp-3'],
            location: 'Room 101',
            startTime: '10:00',
            length: '2'
          }
        }
      };

      const response = await request(app).get('/api/training-sessions');
      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        {
          id: sessionId,
          topic: 'JavaScript Basics',
          trainer: 'Jane Smith',
          date: '2024-03-27',
          participants: 3,
          status: 'completed'
        }
      ]);
    });
  });

  describe('GET /api/training-sessions/employee/:employeeId', () => {
    it('should return 404 when employee not found', async () => {
      const response = await request(app).get('/api/training-sessions/employee/non-existent');
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ message: 'Employee not found' });
    });

    it('should return employee sessions in the correct format', async () => {
      const employeeId = 'emp-1';
      const sessionId = 'session-1';
      data.employees[employeeId] = {
        name: 'John Doe',
        trainingSessions: {
          [sessionId]: {
            topic: 'JavaScript Basics',
            trainer: 'Jane Smith',
            date: '2024-03-27',
            trainees: ['emp-1', 'emp-2'],
            location: 'Room 101',
            startTime: '10:00',
            length: '2'
          }
        }
      };

      const response = await request(app).get(`/api/training-sessions/employee/${employeeId}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        {
          id: sessionId,
          topic: 'JavaScript Basics',
          trainer: 'Jane Smith',
          date: '2024-03-27',
          participants: 2,
          status: 'completed'
        }
      ]);
    });
  });

  describe('POST /api/training-sessions/:employeeId', () => {
    it('should create a new training session', async () => {
      const employeeId = 'emp-1';
      data.employees[employeeId] = {
        name: 'John Doe',
        trainingSessions: {}
      };

      const newSession = {
        topic: 'JavaScript Basics',
        trainer: 'Jane Smith',
        date: '2024-03-27',
        trainees: ['emp-1', 'emp-2'],
        location: 'Room 101',
        startTime: '10:00',
        length: '2'
      };

      const response = await request(app)
        .post(`/api/training-sessions/${employeeId}`)
        .send(newSession);

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('sessionId');
      expect(response.body).toHaveProperty('session');
      expect(data.employees[employeeId].trainingSessions[response.body.sessionId]).toEqual(newSession);
    });
  });
}); 