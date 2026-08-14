import express from 'express';
import validate from '../middleware/validate';
const { requireRole } = require('../middleware/requireRole');
import { rolesAtLeast } from '../utils/roles';
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

// Reads — everyone from trainer up needs the site list (location pickers,
// and the Manage Sites page is viewable — just not editable — by Supervisor
// and Senior Supervisor too).
router.get('/', requireRole(rolesAtLeast('trainer')), getAllSites);
router.get('/:id', requireRole(rolesAtLeast('trainer')), getSiteById);

// Writes — admin only. Unlike most management actions, this isn't something
// Senior Supervisor inherits — site/location setup is org structure, not
// day-to-day training data.
router.post('/', requireRole(rolesAtLeast('admin')), validate(siteSchema), createSite);
router.put('/:id', requireRole(rolesAtLeast('admin')), validate(updateSiteSchema), updateSite);
router.delete('/:id', requireRole(rolesAtLeast('admin')), deleteSite);

export default router;
