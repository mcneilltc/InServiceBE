
// Load .env before anything else — several modules (config/firebase.ts,
// middleware/requireRole.ts, routes/auth.ts) read process.env at import time,
// so this must run first regardless of require/import order elsewhere.
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const port = 5001; // Or any other port

// credentials:true + an explicit origin is required for the httpOnly session
// cookie to ride along on cross-origin requests from the frontend.
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true })); // Parse URL-encoded bodies

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

app.get('/', (req, res) => {
  res.send('Training Management Application Backend is running!');
});

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