import express from 'express';
import validate from '../middleware/validate';
const { requireRole } = require('../middleware/requireRole');
import { rolesAtLeast } from '../utils/roles';
import {
  tierSchema,
  updateTierSchema,
  getAllTiers,
  createTier,
  updateTier,
  deleteTier,
  getIncentiveStatus,
} from '../controllers/incentiveController';

const router = express.Router();
const STAFF = rolesAtLeast('trainer');
const SUPERVISOR = rolesAtLeast('supervisor');

// Reads — supervisors and trainers both can see the current reward tiers.
router.get('/tiers', requireRole(STAFF), getAllTiers);

// Writes and the roster status view (org-wide employee data) — supervisor only.
router.post('/tiers', requireRole(SUPERVISOR), validate(tierSchema), createTier);
router.put('/tiers/:id', requireRole(SUPERVISOR), validate(updateTierSchema), updateTier);
router.delete('/tiers/:id', requireRole(SUPERVISOR), deleteTier);
router.get('/status', requireRole(SUPERVISOR), getIncentiveStatus);

export default router;
