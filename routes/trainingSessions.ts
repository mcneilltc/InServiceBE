import express from 'express';
import validate from '../middleware/validate';
import {
  sessionSchema,
  getAllSessions,
  getEmployeeSessions,
  createSession,
  createTrainingOffering
} from '../controllers/trainingSessionsController';

const router = express.Router();

router.get('/', getAllSessions);
router.get('/employee/:employeeId', getEmployeeSessions);
// POST / creates a new training offering
router.post('/', validate(sessionSchema), createTrainingOffering);
// POST /:employeeId registers an employee in a training
router.post('/:employeeId', validate(sessionSchema), createSession);

export default router;
