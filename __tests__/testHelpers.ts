const jwt = require('jsonwebtoken');

// A signed session cookie for an admin — the top of the role hierarchy (see
// utils/roles.ts), so it satisfies every requireRole(rolesAtLeast(...)) gate
// in the app, including the two admin-only ones (role changes, site
// management). These tests exercise route/controller logic, not the auth
// layer itself (that's covered separately), so one fixed authenticated
// identity is enough. Override `role` (e.g. to 'supervisor' or 'trainer')
// to test a lower tier's access.
export function authCookie(overrides: Record<string, any> = {}): string {
  const claims = {
    email: 'test-supervisor@example.com',
    name: 'Test Supervisor',
    role: 'admin',
    supervisorLocations: [],
    employeeId: null,
    trainerId: null,
    ...overrides,
  };
  const token = jwt.sign(claims, process.env.SESSION_SECRET, { expiresIn: '1h' });
  return `session=${token}`;
}

// A signed session cookie for the 'employee' role (shift pickup), mirroring
// authCookie() above but for the shape employeeAuth login issues.
export function employeeAuthCookie(overrides: Record<string, any> = {}): string {
  const claims = {
    email: 'test-employee@example.com',
    name: 'Test Employee',
    role: 'employee',
    employeeId: 'employee-1',
    wheniworkUserId: 'wiw-user-1',
    provider: 'password',
    accessToken: null,
    ...overrides,
  };
  const token = jwt.sign(claims, process.env.SESSION_SECRET, { expiresIn: '1h' });
  return `session=${token}`;
}
