import express from 'express';
import validate from '../middleware/validate';
const { requireRole } = require('../middleware/requireRole');
import {
  siteSchema,
  updateSiteSchema,
  getAllSites,
  getSiteById,
  createSite,
  updateSite,
  deleteSite
} from '../controllers/sitesController';

const router = express.Router();

// Reads — supervisors and trainers both need the site list (location pickers).
router.get('/', requireRole(['supervisor', 'trainer']), getAllSites);
router.get('/:id', requireRole(['supervisor', 'trainer']), getSiteById);

// Writes — supervisor only (Manage Sites).
router.post('/', requireRole(['supervisor']), validate(siteSchema), createSite);
router.put('/:id', requireRole(['supervisor']), validate(updateSiteSchema), updateSite);
router.delete('/:id', requireRole(['supervisor']), deleteSite);

export default router;
