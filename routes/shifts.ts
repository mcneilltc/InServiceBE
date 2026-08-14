export {};
const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/requireRole');
import { rolesAtLeast } from '../utils/roles';
const { listAvailableInserviceShifts, pickUpShift } = require('../controllers/shiftsController');
const { getAttendanceReport } = require('../controllers/shiftAttendanceController');

router.get('/', requireRole(['employee']), listAvailableInserviceShifts);
// A WIW shift assignment is never treated as proof of attendance — this
// cross-references assigned inservice shifts against actual checkins so a
// supervisor can see (and follow up on) employees who were scheduled but
// never checked in via the training link or a manual add.
router.get('/attendance', requireRole(rolesAtLeast('supervisor')), getAttendanceReport);
router.post('/:id/pickup', requireRole(['employee']), pickUpShift);

export default router;
