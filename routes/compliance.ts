import express from 'express';
import { getComplianceStatus } from '../controllers/complianceController';

const router = express.Router();

// GET /api/compliance/status?month=YYYY-MM
router.get('/status', getComplianceStatus);

export default router;
