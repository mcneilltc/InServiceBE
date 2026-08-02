const { db } = require('../config/firebase');
const { pickUpShift, ShiftPickupError } = require('../services/wheniworkService');

// GET /api/shifts — open, future, inservice-tagged shifts available to pick up.
async function listAvailableInserviceShifts(req: any, res: any, next: any) {
  try {
    const nowISO = new Date().toISOString();
    const snapshot = await db.collection('shifts')
      .where('isInserviceShift', '==', true)
      .where('status', '==', 'open')
      .where('start', '>=', nowISO)
      .orderBy('start', 'asc')
      .get();

    const shifts = snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
    res.json(shifts);
  } catch (error) {
    next(error);
  }
}

// POST /api/shifts/:id/pickup — an employee claims an open shift. All of the
// transactional claim + WIW push + compensating-rollback logic lives in
// wheniworkService.pickUpShift so it stays testable independent of Express.
async function pickUpShiftHandler(req: any, res: any, next: any) {
  try {
    const { id } = req.params;
    const employeeId = req.user?.employeeId;
    if (!employeeId) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const result = await pickUpShift(id, employeeId);
    res.json({ message: 'Shift picked up', ...result });
  } catch (error: any) {
    if (error instanceof ShiftPickupError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    next(error);
  }
}

export { listAvailableInserviceShifts, pickUpShiftHandler as pickUpShift };
