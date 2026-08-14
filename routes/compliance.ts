import express from 'express';
import { getComplianceStatus, sendMidMonthNotices, sendEndOfMonthAlerts } from '../controllers/complianceController';
import { sendComplianceLetter, downloadComplianceLetter } from '../controllers/complianceLetterController';

const router = express.Router();

// GET /api/compliance/status?month=YYYY-MM
router.get('/status', getComplianceStatus);

// Manual triggers
router.post('/notify-midmonth', sendMidMonthNotices);
router.post('/notify-endofmonth', sendEndOfMonthAlerts);

// Generates the compliance letter from the template and emails it to the employee.
router.post('/letter/:employeeId/send', sendComplianceLetter);

// Generates the compliance letter and streams it back as a PDF download.
router.get('/letter/:employeeId/download', downloadComplianceLetter);

export default router;
