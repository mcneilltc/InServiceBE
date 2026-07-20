import express from 'express';
import validate from '../middleware/validate';
const { requireRole } = require('../middleware/requireRole');
import {
  sessionSchema,
  getAllSessions,
  getEmployeeSessions,
  createSession,
  createTrainingOffering
} from '../controllers/trainingSessionsController';

const router = express.Router();

const STAFF = ['supervisor', 'trainer'];

router.get('/', requireRole(STAFF), getAllSessions);

// Stays public — this is the same self-service tier as badge lookup, an
// employee viewing their own training history (src/pages/employee-hours).
router.get('/employee/:employeeId', getEmployeeSessions);

// POST / creates a new training offering
router.post('/', requireRole(STAFF), validate(sessionSchema), createTrainingOffering);
// POST /:employeeId registers an employee in a training
router.post('/:employeeId', requireRole(STAFF), validate(sessionSchema), createSession);

export default router;
