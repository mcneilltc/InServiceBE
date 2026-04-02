import express from 'express';
import validate from '../middleware/validate';
import {
  sessionSchema,
  getAllSessions,
  getEmployeeSessions,
  createSession
} from '../controllers/trainingSessionsController';

const router = express.Router();

router.get('/', getAllSessions);
router.get('/employee/:employeeId', getEmployeeSessions);
router.post('/:employeeId', validate(sessionSchema), createSession);

export default router;
