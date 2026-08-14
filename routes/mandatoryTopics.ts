import express from 'express';
const router = express.Router();
const { requireRole } = require('../middleware/requireRole');
import { rolesAtLeast } from '../utils/roles';
import { getForMonth, getForDate, setForMonth } from '../controllers/mandatoryTopicsController';

// Reads — any supervisor or trainer needs this to know what's mandatory
// when creating a session.
router.get('/for-date', requireRole(rolesAtLeast('trainer')), getForDate);
router.get('/:yearMonth', requireRole(rolesAtLeast('trainer')), getForMonth);

// Write — role-gated here, fine-grained seniorSupervisor-and-up check
// happens live inside the controller (see setForMonth).
router.put('/:yearMonth', requireRole(rolesAtLeast('supervisor')), setForMonth);

export default router;
