const { getShiftAttendanceReport } = require('../services/shiftAttendanceService');

// GET /api/shifts/attendance?onlyMissed=false — supervisor only.
async function getAttendanceReport(req: any, res: any, next: any) {
  try {
    const onlyMissed = req.query.onlyMissed !== 'false';
    const rows = await getShiftAttendanceReport({ onlyMissed });
    res.json(rows);
  } catch (error) {
    next(error);
  }
}

export { getAttendanceReport };
