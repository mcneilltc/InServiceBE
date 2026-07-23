export {};
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const dns = require('dns').promises;
const { verifyGoogleToken, verifyMicrosoftToken, verifyYahooToken } = require('../utils');
const { resolveRole } = require('../services/authService');
const { COOKIE_OPTIONS, SESSION_MAX_AGE_SECONDS } = require('../middleware/requireRole');

const getSessionSecret = () => process.env.SESSION_SECRET;

// Well-known consumer webmail domains — checked first since they're instant
// and unambiguous, no DNS round-trip needed.
const GOOGLE_DOMAINS = ['gmail.com', 'googlemail.com'];
const MICROSOFT_DOMAINS = ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'];
const YAHOO_DOMAINS = ['yahoo.com', 'ymail.com', 'rocketmail.com'];

// GET /api/auth/detect-provider?email=... — public, unauthenticated (this is
// what decides which sign-in button to redirect to, before anyone's signed
// in). For a custom/organizational domain (e.g. a county .gov domain) that
// isn't one of the well-known consumer domains above, this falls back to a
// DNS MX-record lookup: which mail servers actually handle that domain's
// email reveals whether it's backed by Google Workspace or Microsoft 365,
// without needing a manually maintained domain list.
router.get('/detect-provider', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  const domain = email.split('@')[1];

  if (!domain) {
    return res.json({ provider: 'unknown' });
  }

  if (GOOGLE_DOMAINS.includes(domain)) return res.json({ provider: 'google' });
  if (MICROSOFT_DOMAINS.includes(domain)) return res.json({ provider: 'microsoft' });
  if (YAHOO_DOMAINS.includes(domain)) return res.json({ provider: 'yahoo' });

  try {
    const mxRecords = await dns.resolveMx(domain);
    const exchanges = mxRecords.map((r: any) => r.exchange.toLowerCase());

    if (exchanges.some((e: string) => e.includes('google.com') || e.includes('googlemail.com') || e.includes('aspmx.l.google.com'))) {
      return res.json({ provider: 'google' });
    }
    if (exchanges.some((e: string) => e.includes('outlook.com') || e.includes('protection.outlook.com'))) {
      return res.json({ provider: 'microsoft' });
    }
    if (exchanges.some((e: string) => e.includes('yahoodns.net'))) {
      return res.json({ provider: 'yahoo' });
    }
  } catch (error) {
    // Domain doesn't resolve, has no MX records, or the lookup otherwise
    // failed — fall through to 'unknown' below rather than error out; the
    // frontend falls back to a manual provider picker in that case.
  }

  return res.json({ provider: 'unknown' });
});

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

// POST /api/auth/yahoo — body: { accessToken }
router.post('/yahoo', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) {
      return res.status(400).json({ message: 'accessToken is required' });
    }

    const profile = await verifyYahooToken(accessToken);
    await completeLogin(res, profile.email, profile.name || null);
  } catch (error: any) {
    console.error('Yahoo login failed:', error);
    res.status(401).json({ message: 'Invalid Yahoo credentials' });
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
