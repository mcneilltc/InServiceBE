import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import app from '../app';
import { db } from '../config/firebase';
import { authCookie, employeeAuthCookie } from './testHelpers';

jest.mock('../config/firebase', () => ({
  db: {
    collection: jest.fn(),
  },
}));

jest.mock('../services/messagingService', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  employeeShiftLoginInviteTemplate: jest.fn().mockReturnValue('<p>invite</p>'),
}));

const { sendEmail } = require('../services/messagingService');

describe('POST /api/auth/employee/login', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockEmployees(employees: any[]) {
    (db.collection as jest.Mock).mockReturnValue({
      get: jest.fn().mockResolvedValue({
        docs: employees.map((e, i) => ({ id: e.id || `employee-${i}`, data: () => e })),
      }),
    });
  }

  it('logs in with correct credentials and sets a session cookie', async () => {
    const passwordHash = await bcrypt.hash('correct-horse', 10);
    mockEmployees([{ id: 'employee-1', name: 'Jamie', email: 'jamie@example.com', isActive: true, passwordHash }]);

    const response = await request(app)
      .post('/api/auth/employee/login')
      .send({ email: 'jamie@example.com', password: 'correct-horse' });

    expect(response.status).toBe(200);
    expect(response.headers['set-cookie'][0]).toMatch(/^session=/);
    expect(response.body.user).toMatchObject({ role: 'employee', employeeId: 'employee-1' });
  });

  it('rejects the wrong password', async () => {
    const passwordHash = await bcrypt.hash('correct-horse', 10);
    mockEmployees([{ id: 'employee-1', name: 'Jamie', email: 'jamie@example.com', isActive: true, passwordHash }]);

    const response = await request(app)
      .post('/api/auth/employee/login')
      .send({ email: 'jamie@example.com', password: 'wrong-password' });

    expect(response.status).toBe(401);
  });

  it('rejects an inactive employee even with the correct password', async () => {
    const passwordHash = await bcrypt.hash('correct-horse', 10);
    mockEmployees([{ id: 'employee-1', name: 'Jamie', email: 'jamie@example.com', isActive: false, passwordHash }]);

    const response = await request(app)
      .post('/api/auth/employee/login')
      .send({ email: 'jamie@example.com', password: 'correct-horse' });

    expect(response.status).toBe(403);
  });

  it('rejects an employee who has never set a password (never invited)', async () => {
    mockEmployees([{ id: 'employee-1', name: 'Jamie', email: 'jamie@example.com', isActive: true, passwordHash: null }]);

    const response = await request(app)
      .post('/api/auth/employee/login')
      .send({ email: 'jamie@example.com', password: 'anything' });

    expect(response.status).toBe(401);
  });

  it('is case-insensitive on email and returns 401 (not a crash) for an unknown email', async () => {
    mockEmployees([]);
    const response = await request(app)
      .post('/api/auth/employee/login')
      .send({ email: 'nobody@example.com', password: 'anything' });

    expect(response.status).toBe(401);
  });
});

describe('POST /api/auth/employee/invite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires a supervisor session', async () => {
    const response = await request(app)
      .post('/api/auth/employee/invite')
      .set('Cookie', employeeAuthCookie())
      .send({ employeeId: 'employee-1' });

    expect(response.status).toBe(403);
  });

  it('sends an invite email for an employee with an email on file', async () => {
    (db.collection as jest.Mock).mockReturnValue({
      doc: jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ name: 'Jamie', email: 'jamie@example.com' }) }),
      }),
    });

    const response = await request(app)
      .post('/api/auth/employee/invite')
      .set('Cookie', authCookie())
      .send({ employeeId: 'employee-1' });

    expect(response.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith('jamie@example.com', expect.any(String), expect.any(String));
  });

  it('rejects an employee with no email on file', async () => {
    (db.collection as jest.Mock).mockReturnValue({
      doc: jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ name: 'Jamie', email: '' }) }),
      }),
    });

    const response = await request(app)
      .post('/api/auth/employee/invite')
      .set('Cookie', authCookie())
      .send({ employeeId: 'employee-1' });

    expect(response.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/employee/set-password', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('consumes a valid invite token and sets the password', async () => {
    const mockUpdate = jest.fn().mockResolvedValue(undefined);
    (db.collection as jest.Mock).mockReturnValue({
      doc: jest.fn().mockReturnValue({ update: mockUpdate }),
    });

    const token = jwt.sign(
      { employeeId: 'employee-1', purpose: 'employee-invite' },
      process.env.EMPLOYEE_INVITE_TOKEN_SECRET,
      { expiresIn: '24h' }
    );

    const response = await request(app)
      .post('/api/auth/employee/set-password')
      .send({ token, password: 'a-new-password' });

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ passwordHash: expect.any(String) }));
  });

  it('rejects an expired invite token', async () => {
    const token = jwt.sign(
      { employeeId: 'employee-1', purpose: 'employee-invite' },
      process.env.EMPLOYEE_INVITE_TOKEN_SECRET,
      { expiresIn: '-1h' }
    );

    const response = await request(app)
      .post('/api/auth/employee/set-password')
      .send({ token, password: 'a-new-password' });

    expect(response.status).toBe(401);
  });

  it('rejects a token not issued for the employee-invite purpose (e.g. a session cookie)', async () => {
    const sessionShapedToken = jwt.sign(
      { employeeId: 'employee-1', role: 'employee' },
      process.env.EMPLOYEE_INVITE_TOKEN_SECRET,
      { expiresIn: '1h' }
    );

    const response = await request(app)
      .post('/api/auth/employee/set-password')
      .send({ token: sessionShapedToken, password: 'a-new-password' });

    expect(response.status).toBe(401);
  });

  it('rejects a password shorter than 8 characters', async () => {
    const token = jwt.sign(
      { employeeId: 'employee-1', purpose: 'employee-invite' },
      process.env.EMPLOYEE_INVITE_TOKEN_SECRET,
      { expiresIn: '24h' }
    );

    const response = await request(app).post('/api/auth/employee/set-password').send({ token, password: 'short' });

    expect(response.status).toBe(400);
  });
});
