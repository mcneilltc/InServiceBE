export {};
const jwt = require('jsonwebtoken');

// Read lazily (at call time, not module-load time) — env vars must already be
// loaded by the time requests are handled, but module import order isn't
// guaranteed to happen after dotenv.config() runs.
const getSessionSecret = () => process.env.SESSION_SECRET;
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60; // 12 hours, roughly a work shift
const REFRESH_THRESHOLD_SECONDS = SESSION_MAX_AGE_SECONDS / 2;

// Most of the frontend calls this API directly cross-origin (localhost:3000 ->
// localhost:5001), not through the Next.js rewrite proxy — so this is a
// genuinely cross-site request from the browser's perspective. SameSite=Lax
// cookies are excluded from cross-site fetch/XHR (only sent on top-level
// navigation), so this needs SameSite=None, which in turn requires Secure.
// Chrome/Firefox treat http://localhost as a trustworthy origin, so Secure
// cookies still work there without TLS in local dev; a real multi-origin
// deployment needs both origins served over HTTPS for this to work at all.
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'none' as const,
  maxAge: SESSION_MAX_AGE_SECONDS * 1000,
};

// Verifies the session cookie and checks the caller's role against allowedRoles.
// Attaches the decoded session payload to req.user. Also handles a sliding
// refresh — if the session is more than halfway through its lifetime, it's
// silently re-issued so an active user doesn't get logged out mid-shift.
const requireRole = (allowedRoles: string[]) => (req: any, res: any, next: any) => {
  const token = req.cookies?.session;
  if (!token) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  let payload: any;
  try {
    payload = jwt.verify(token, getSessionSecret());
  } catch (error) {
    return res.status(401).json({ message: 'Session expired or invalid' });
  }

  if (!allowedRoles.includes(payload.role)) {
    return res.status(403).json({ message: 'Not authorized for this resource' });
  }

  req.user = payload;

  const now = Math.floor(Date.now() / 1000);
  const issuedAt = payload.iat || now;
  if (now - issuedAt > REFRESH_THRESHOLD_SECONDS) {
    const { iat, exp, ...claims } = payload;
    const newToken = jwt.sign(claims, getSessionSecret(), { expiresIn: SESSION_MAX_AGE_SECONDS });
    res.cookie('session', newToken, COOKIE_OPTIONS);
  }

  next();
};

module.exports = { requireRole, COOKIE_OPTIONS, SESSION_MAX_AGE_SECONDS };
