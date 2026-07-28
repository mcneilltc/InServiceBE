import express from 'express';
import { getComplianceStatus, sendMidMonthNotices, sendEndOfMonthAlerts } from '../controllers/complianceController';

const router = express.Router();

// GET /api/compliance/status?month=YYYY-MM
router.get('/status', getComplianceStatus);

// Manual triggers
router.post('/notify-midmonth', sendMidMonthNotices);
router.post('/notify-endofmonth', sendEndOfMonthAlerts);

export default router;
