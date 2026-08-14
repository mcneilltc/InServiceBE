import express from 'express';
const router = express.Router();
const { requireRole } = require('../middleware/requireRole');
import { rolesAtLeast } from '../utils/roles';
import { getCertificationsOverview } from '../controllers/certificationsController';

router.get('/', requireRole(rolesAtLeast('supervisor')), getCertificationsOverview);

export default router;
