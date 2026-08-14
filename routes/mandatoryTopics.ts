import express from 'express';
const router = express.Router();
const { requireRole } = require('../middleware/requireRole');
import { getForMonth, getForDate, setForMonth } from '../controllers/mandatoryTopicsController';

// Reads — any supervisor or trainer needs this to know what's mandatory
// when creating a session.
router.get('/for-date', requireRole(['supervisor', 'trainer']), getForDate);
router.get('/:yearMonth', requireRole(['supervisor', 'trainer']), getForMonth);

// Write — role-gated here, fine-grained canManageMandatoryTopics check
// happens live inside the controller (see setForMonth).
router.put('/:yearMonth', requireRole(['supervisor']), setForMonth);

export default router;
