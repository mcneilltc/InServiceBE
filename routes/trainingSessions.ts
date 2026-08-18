import express from 'express';
import validate from '../middleware/validate';
const { requireRole } = require('../middleware/requireRole');
import { rolesAtLeast } from '../utils/roles';
import {
  sessionSchema,
  getAllSessions,
  getEmployeeSessions,
  createSession,
  createTrainingOffering,
  updateEmployeeTrainingSession
} from '../controllers/trainingSessionsController';

const router = express.Router();

const STAFF = rolesAtLeast('trainer');

router.get('/', requireRole(STAFF), getAllSessions);

// Stays public — this is the same self-service tier as badge lookup, an
// employee viewing their own training history (src/pages/employee-hours).
router.get('/employee/:employeeId', getEmployeeSessions);

// POST / creates a new training offering
router.post('/', requireRole(STAFF), validate(sessionSchema), createTrainingOffering);
// POST /:employeeId registers an employee in a training
router.post('/:employeeId', requireRole(STAFF), validate(sessionSchema), createSession);

// PATCH /:employeeId/:sessionDocId corrects an already-credited session's
// hours for one employee (e.g. they left before close-out) — see
// updateEmployeeTrainingSession for the permission tier and delta logic.
router.patch('/:employeeId/:sessionDocId', requireRole(STAFF), updateEmployeeTrainingSession);

export default router;
