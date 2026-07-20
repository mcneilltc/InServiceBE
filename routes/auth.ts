export {};
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { verifyGoogleToken, verifyMicrosoftToken } = require('../utils');
const { resolveRole } = require('../services/authService');
const { COOKIE_OPTIONS, SESSION_MAX_AGE_SECONDS } = require('../middleware/requireRole');

const getSessionSecret = () => process.env.SESSION_SECRET;

// Verifies the caller's identity server-side, resolves their role, and — if
// authorized — issues a signed session cookie. This is the only place a
// session gets created; the email used for role lookup always comes from the
// verified token payload, never from anything the client claims directly.
async function completeLogin(res: any, email: string, name: string | null) {
  const resolved = await resolveRole(email);

  if (!resolved.isWhitelisted) {
    return res.status(403).json({
      isWhitelisted: false,
      message: 'Your email is not authorized to access this application. Please contact an administrator.',
    });
  }

  const claims = {
    email,
    name: resolved.name || name || null,
    role: resolved.role,
    supervisorScope: resolved.supervisorScope || null,
    supervisorLocations: resolved.supervisorLocations || [],
    employeeId: resolved.employeeId || null,
    trainerId: resolved.trainerId || null,
  };

  const token = jwt.sign(claims, getSessionSecret(), { expiresIn: SESSION_MAX_AGE_SECONDS });
  res.cookie('session', token, COOKIE_OPTIONS);
  res.json({ isWhitelisted: true, user: claims });
}

// POST /api/auth/google — body: { idToken }
router.post('/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ message: 'idToken is required' });
    }

    const payload = await verifyGoogleToken(idToken);
    await completeLogin(res, payload.email, payload.name || null);
  } catch (error: any) {
    console.error('Google login failed:', error);
    res.status(401).json({ message: 'Invalid Google credentials' });
  }
});

// POST /api/auth/microsoft — body: { accessToken }
router.post('/microsoft', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) {
      return res.status(400).json({ message: 'accessToken is required' });
    }

    const profile = await verifyMicrosoftToken(accessToken);
    await completeLogin(res, profile.email, profile.name || null);
  } catch (error: any) {
    console.error('Microsoft login failed:', error);
    res.status(401).json({ message: 'Invalid Microsoft credentials' });
  }
});

// GET /api/auth/session — used on app load to hydrate auth state from the cookie
router.get('/session', (req, res) => {
  const token = req.cookies?.session;
  if (!token) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  try {
    const payload = jwt.verify(token, getSessionSecret());
    const { iat, exp, ...user } = payload;
    res.json({ user });
  } catch (error) {
    res.status(401).json({ message: 'Session expired or invalid' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('session', { ...COOKIE_OPTIONS, maxAge: undefined });
  res.json({ message: 'Logged out' });
});

export default router;
