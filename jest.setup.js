// Fixed test-only secret so requireRole middleware and __tests__/testHelpers.ts
// sign/verify against the same value, independent of the real .env file.
process.env.SESSION_SECRET = 'test-session-secret';

// Fixed test-only secret for employee invite/set-password tokens (see
// services/employeeAuthService.ts), independent of the real .env file.
process.env.EMPLOYEE_INVITE_TOKEN_SECRET = 'test-employee-invite-secret';
