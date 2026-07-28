const jwt = require('jsonwebtoken');

// A signed session cookie for a supervisor — the superset role, so it
// satisfies both requireRole(['supervisor']) and requireRole(['supervisor','trainer'])
// gates. These tests exercise route/controller logic, not the auth layer itself
// (that's covered separately), so one fixed authenticated identity is enough.
export function authCookie(overrides: Record<string, any> = {}): string {
  const claims = {
    email: 'test-supervisor@example.com',
    name: 'Test Supervisor',
    role: 'supervisor',
    supervisorScope: 'all',
    supervisorLocations: [],
    employeeId: null,
    trainerId: null,
    ...overrides,
  };
  const token = jwt.sign(claims, process.env.SESSION_SECRET, { expiresIn: '1h' });
  return `session=${token}`;
}
