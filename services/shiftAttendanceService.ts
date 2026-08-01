import { db } from '../config/firebase';
import moment from 'moment';

export interface ShiftAttendanceRow {
  shiftId: string;
  employeeId: string;
  employeeName: string;
  badgeNumber: string | null;
  homeLocation: string;
  start: string;
  end: string;
  notes: string;
  attended: boolean;
}

// A WIW shift only tells us an employee was *scheduled* for inservice — it is
// never treated as proof they actually trained. Attendance is decided solely
// by whether a `checkins` doc (self check-in via the electronic form, or a
// trainer/supervisor manually adding them) falls inside the shift's window.
// This report exists to surface the gap between the two, not to close it —
// a WIW assignment must never auto-create or imply a checkin.
function checkinFallsWithinShift(checkinTime: string, start: string, end: string): boolean {
  const t = moment(checkinTime);
  return t.isValid() && t.isSameOrAfter(moment(start)) && t.isSameOrBefore(moment(end));
}

export async function getShiftAttendanceReport(options: { onlyMissed?: boolean; asOf?: moment.Moment } = {}): Promise<ShiftAttendanceRow[]> {
  const { onlyMissed = true, asOf = moment() } = options;
  const nowISO = asOf.toISOString();

  // A compound Firestore query across isInserviceShift + status + start would
  // need a composite index that doesn't exist in this project yet, so this
  // fetches on the one indexed field and filters the rest in memory — fine
  // at this app's scale (one shift collection per organization, not millions
  // of rows).
  //
  // Only assigned (claimed) inservice shifts whose window has already started
  // are judgeable — an unclaimed ("open") shift has no one to hold
  // accountable, and a future shift hasn't happened yet.
  const shiftsSnap = await db.collection('shifts').where('isInserviceShift', '==', true).get();

  const shifts = shiftsSnap.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() as any) }))
    .filter((s) => s.status === 'assigned' && !!s.employeeId && s.start <= nowISO);

  if (shifts.length === 0) return [];

  const employeeIds = Array.from(new Set(shifts.map((s) => s.employeeId as string)));

  const [employeeDocs, checkinsByEmployee] = await Promise.all([
    Promise.all(employeeIds.map((id) => db.collection('employees').doc(id).get())),
    Promise.all(
      employeeIds.map(async (id) => {
        const snap = await db.collection('checkins').where('employeeId', '==', id).get();
        return [id, snap.docs.map((d) => d.data() as any)] as const;
      })
    ),
  ]);

  const employeeById = new Map(
    employeeDocs.filter((d) => d.exists).map((d) => [d.id, d.data() as any])
  );
  const checkinsById = new Map(checkinsByEmployee);

  const rows: ShiftAttendanceRow[] = shifts.map((shift) => {
    const employee = employeeById.get(shift.employeeId) || {};
    const checkins = checkinsById.get(shift.employeeId) || [];
    const attended = checkins.some((c) => checkinFallsWithinShift(c.checkinTime, shift.start, shift.end));

    return {
      shiftId: shift.id,
      employeeId: shift.employeeId,
      employeeName: employee.name || `${employee.firstName || ''} ${employee.lastName || ''}`.trim() || 'Unknown Employee',
      badgeNumber: employee.badgeNumber || null,
      homeLocation: employee.homeLocation || '',
      start: shift.start,
      end: shift.end,
      notes: shift.notes || '',
      attended,
    };
  });

  rows.sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());

  return onlyMissed ? rows.filter((r) => !r.attended) : rows;
}
