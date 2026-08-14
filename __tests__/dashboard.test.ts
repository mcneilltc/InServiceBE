export {};
const request = require('supertest');
const app = require('../app').default;
const { db } = require('../config/firebase');
const { authCookie } = require('./testHelpers');

describe('Dashboard API', () => {
  beforeEach(async () => {
    // Clear test data before each test
    const employeesSnapshot = await db.collection('employees').get();
    for (const doc of employeesSnapshot.docs) {
      await doc.ref.delete();
    }
  });

  describe('GET /api/dashboard/training-hours-by-location', () => {
    it('should return empty object when no sessions exist', async () => {
      const response = await request(app).get('/api/dashboard/training-hours-by-location').set('Cookie', authCookie());
      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });

    it('should aggregate training hours by location', async () => {
      // Create test data
      const employeeRef = await db.collection('employees').add({
        name: 'John Doe'
      });

      await employeeRef.collection('trainingSessions').add({
        location: 'Room 101',
        length: '2',
        date: '2024-03-27'
      });

      await employeeRef.collection('trainingSessions').add({
        location: 'Room 102',
        length: '3',
        date: '2024-03-28'
      });

      const response = await request(app).get('/api/dashboard/training-hours-by-location').set('Cookie', authCookie());
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        'Room 101': 2,
        'Room 102': 3
      });
    });
  });

  describe('GET /api/dashboard/employee-hours/:employeeId/monthly', () => {
    it('should return 0 hours for non-existent employee', async () => {
      const response = await request(app).get('/api/dashboard/employee-hours/non-existent/monthly').set('Cookie', authCookie());
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ totalHours: 0 });
    });

    it('should calculate monthly training hours', async () => {
      // Create test data
      const employeeRef = await db.collection('employees').add({
        name: 'John Doe'
      });

      await employeeRef.collection('trainingSessions').add({
        length: '2',
        date: '2024-03-27'
      });

      await employeeRef.collection('trainingSessions').add({
        length: '3',
        date: '2024-03-28'
      });

      const response = await request(app)
        .get(`/api/dashboard/employee-hours/${employeeRef.id}/monthly`)
        .set('Cookie', authCookie())
        .query({ month: 3, year: 2024 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ totalHours: 5 });
    });
  });

  describe('GET /api/dashboard/employee-hours/:employeeId/yearly', () => {
    it('should return 0 hours for non-existent employee', async () => {
      const response = await request(app).get('/api/dashboard/employee-hours/non-existent/yearly').set('Cookie', authCookie());
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ totalHours: 0 });
    });

    it('should calculate yearly training hours', async () => {
      // Create test data
      const employeeRef = await db.collection('employees').add({
        name: 'John Doe'
      });

      await employeeRef.collection('trainingSessions').add({
        length: '2',
        date: '2024-03-27'
      });

      await employeeRef.collection('trainingSessions').add({
        length: '3',
        date: '2024-12-28'
      });

      const response = await request(app)
        .get(`/api/dashboard/employee-hours/${employeeRef.id}/yearly`)
        .set('Cookie', authCookie())
        .query({ year: 2024 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ totalHours: 5 });
    });
  });

  describe('GET /api/dashboard/stats — hours-exempt supervisors', () => {
    it('leaves an exempt employee out of employeesNeedingTraining entirely', async () => {
      await db.collection('employees').add({
        name: 'Exempt Supervisor',
        homeLocation: 'MCAC',
        isActive: true,
        role: 'supervisor',
        isExemptFromHoursRequirement: true,
      });
      await db.collection('employees').add({
        name: 'Regular Lifeguard',
        homeLocation: 'MCAC',
        isActive: true,
        // A cert on file — this test targets the exemption flag, not the
        // separate certificationStatus gate (see certificationGating.test.ts).
        certifications: [{ type: 'Lifeguarding', expirationDate: '2099-01-01' }],
      });

      const response = await request(app)
        .get('/api/dashboard/stats')
        .set('Cookie', authCookie())
        .query({ period: 'month' });

      expect(response.status).toBe(200);
      const names = response.body.employeesNeedingTraining.map((e: any) => e.name);
      expect(names).toContain('Regular Lifeguard');
      expect(names).not.toContain('Exempt Supervisor');
    });
  });
}); 