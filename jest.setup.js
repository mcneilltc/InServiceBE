// Fixed test-only secret so requireRole middleware and __tests__/testHelpers.ts
// sign/verify against the same value, independent of the real .env file.
process.env.SESSION_SECRET = 'test-session-secret';
