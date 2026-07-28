import express from 'express';
const router = express.Router();
const { requireRole } = require('../middleware/requireRole');
import { getCertificationsOverview } from '../controllers/certificationsController';

router.get('/', requireRole(['supervisor']), getCertificationsOverview);

export default router;
