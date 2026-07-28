import express from 'express';
import { getSessionAnalytics, getComplianceOutlook } from '../controllers/trainingAnalyticsController';

const router = express.Router();

// GET /api/training-analytics/sessions?period=week|month|year&sites=A,B
router.get('/sessions', getSessionAnalytics);

// GET /api/training-analytics/compliance-outlook?period=week|month|year&sites=A,B
router.get('/compliance-outlook', getComplianceOutlook);

export default router;
