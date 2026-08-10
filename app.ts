
// Load .env before anything else — several modules (config/firebase.ts,
// middleware/requireRole.ts, routes/auth.ts) read process.env at import time,
// so this must run first regardless of require/import order elsewhere.
require('dotenv').config();

// The Firestore Admin SDK's streaming Query.get() (used everywhere in this
// app) can, on certain low-level gRPC errors — RESOURCE_EXHAUSTED (quota)
// among them — emit an error on the underlying stream *after* the promise
// it backs has already rejected and been caught. Node's default behavior
// for an unlistened 'error' event is to throw and kill the process, so a
// single quota hiccup on a background poller (session-automation) was
// enough to take the entire API down for every user, not just fail that one
// request. Logging and staying up is the right tradeoff here — a transient
// Firestore error should degrade individual requests, not the whole server.
process.on('uncaughtException', (err: Error) => {
  console.error('[uncaughtException] Not crashing — logging and continuing:', err);
});
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[unhandledRejection] Not crashing — logging and continuing:', reason);
});

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const errorHandler = require('./middleware/errorHandler');

const app = express();
// Render (and most PaaS hosts) inject their own PORT env var and route
// traffic based on what the process actually binds to — a hardcoded port
// would silently fail to receive traffic there. Falls back to 5001 for
// local dev, where nothing sets PORT.
const port = process.env.PORT || 5001;

// credentials:true + an explicit origin is required for the httpOnly session
// cookie to ride along on cross-origin requests from the frontend.
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(cookieParser());
// Captures the raw request bytes onto req.rawBody alongside the normal JSON
// parse — needed so the When I Work webhook route can verify an HMAC
// signature against the exact bytes WIW signed (by the time a handler sees
// req.body it's already been parsed, and the original bytes are gone).
// Harmless for every other route, which never reads req.rawBody.
app.use(express.json({ verify: (req: any, res: any, buf: Buffer) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// Import your API routes here (will be created in the next steps)
import employeeRoutes from './routes/employees';
import trainingSessionRoutes from './routes/trainingSessions';
import trainingTopicRoutes from './routes/trainingTopics';
import dashboardRoutes from './routes/dashboard';
import checkinRoutes from './routes/checkin';
import sessionRoutes from './routes/sessions';

import reportRoutes from './routes/reports';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import ocrRoutes from './routes/ocr';
import complianceRoutes from './routes/compliance';
import employeeSelfServiceRoutes from './routes/employeeSelfService';
import certificationRoutes from './routes/certifications';
import siteRoutes from './routes/sites';
import trainingAnalyticsRoutes from './routes/trainingAnalytics';
import wheniworkRoutes from './routes/wheniwork';
import shiftRoutes from './routes/shifts';
import employeeAuthRoutes from './routes/employeeAuth';
import incentiveRoutes from './routes/incentives';
import { runSessionAutomationCheck } from './services/sessionAutomation';
const { requireRole } = require('./middleware/requireRole');

const SUPERVISOR = requireRole(['supervisor']);
const STAFF = requireRole(['supervisor', 'trainer']);

app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/training-sessions', trainingSessionRoutes);
app.use('/api/training-topics', trainingTopicRoutes);
app.use('/api/dashboard', SUPERVISOR, dashboardRoutes);
app.use('/api/checkin', checkinRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/reports', STAFF, reportRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ocr', STAFF, ocrRoutes);
app.use('/api/compliance', SUPERVISOR, complianceRoutes);
app.use('/api/employee', employeeSelfServiceRoutes);
app.use('/api/certifications', certificationRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/training-analytics', SUPERVISOR, trainingAnalyticsRoutes);
// No requireRole gate here — When I Work calls this directly; the route
// verifies an HMAC signature internally instead (see routes/wheniwork.ts).
app.use('/api/wheniwork', wheniworkRoutes);
app.use('/api/shifts', shiftRoutes);
app.use('/api/auth/employee', employeeAuthRoutes);
app.use('/api/incentives', incentiveRoutes);

app.get('/', (req, res) => {
  res.send('Training Management Application Backend is running!');
});

// TEMPORARY dev-only login shortcut for manual browser verification — remove before committing.
if (process.env.NODE_ENV !== 'production') {
  app.get('/__dev_login', async (req: any, res: any) => {
    const jwt = require('jsonwebtoken');
    const { resolveRole } = require('./services/authService');
    const { COOKIE_OPTIONS, SESSION_MAX_AGE_SECONDS } = require('./middleware/requireRole');
    const email = req.query.email || 'tiquilamcneill@gmail.com';
    const resolved = await resolveRole(email);
    const claims = {
      email,
      name: resolved.name || 'Dev Test',
      role: resolved.role,
      supervisorScope: resolved.supervisorScope || null,
      supervisorLocations: resolved.supervisorLocations || [],
      employeeId: resolved.employeeId || null,
    };
    const token = jwt.sign(claims, process.env.SESSION_SECRET, { expiresIn: SESSION_MAX_AGE_SECONDS });
    res.cookie('session', token, COOKIE_OPTIONS);
    res.redirect(process.env.FRONTEND_URL || 'http://localhost:3000');
  });
}

// Error Handling Middleware (must be exactly after all routes)
app.use(errorHandler);

// Only start the server if this file is run directly
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });

  // Reminds a session's trainer(s) 5 minutes after the scheduled end if it
  // hasn't been closed out, then auto-closes it 24 hours after the scheduled
  // end (crediting the session's listed duration, not real elapsed time)
  // if it's still open. Polling every minute keeps both thresholds tight
  // without needing an external scheduler.
  const SESSION_AUTOMATION_INTERVAL_MS = 60 * 1000;
  setInterval(() => {
    runSessionAutomationCheck().catch((err) => {
      console.error('[session-automation] Check failed:', err);
    });
  }, SESSION_AUTOMATION_INTERVAL_MS);
  runSessionAutomationCheck().catch((err) => {
    console.error('[session-automation] Initial check failed:', err);
  });
}

export default app;