export {};
const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/requireRole');
const { listAvailableInserviceShifts, pickUpShift } = require('../controllers/shiftsController');

router.get('/', requireRole(['employee']), listAvailableInserviceShifts);
router.post('/:id/pickup', requireRole(['employee']), pickUpShift);

export default router;
