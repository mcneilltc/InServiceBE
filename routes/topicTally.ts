import express from 'express';
const router = express.Router();
import { getEmployeeTopicTally, getTrainerTopicTally } from '../controllers/topicTallyController';

// Supervisor-only gate applied at the mount point in app.ts (SUPERVISOR),
// same convention as routes/trainingAnalytics.ts — this is the
// per-employee/per-trainer breakdown of the same org-wide topic data.
router.get('/employees', getEmployeeTopicTally);
router.get('/trainers', getTrainerTopicTally);

export default router;
