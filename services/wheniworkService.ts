import { db } from '../config/firebase';
import { assignShiftToUser } from './wheniworkClient';

const DEFAULT_INSERVICE_KEYWORD = '[Inservice]';

function getInserviceKeyword(): string {
  return process.env.WHENIWORK_INSERVICE_KEYWORD || DEFAULT_INSERVICE_KEYWORD;
}

// Single shared keyword-match function — every place that needs to decide
// "is this a pick-up-able inservice shift?" goes through this, so the
// convention only lives in one place.
function isInserviceNotes(notes: string | null | undefined): boolean {
  if (!notes) return false;
  return notes.toLowerCase().includes(getInserviceKeyword().toLowerCase());
}

// Looks up the local employee linked to a WIW user (set via the backfill
// script or a supervisor manually linking an employee — see
// scripts/linkAndBackfillWheniwork.ts). Returns null if unlinked.
async function resolveEmployeeIdForWiwUser(wheniworkUserId: string | null | undefined): Promise<string | null> {
  if (!wheniworkUserId) return null;
  const snapshot = await db.collection('employees')
    .where('wheniworkUserId', '==', wheniworkUserId)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  return snapshot.docs[0].id;
}

async function linkEmployeeToWiwUser(employeeId: string, wheniworkUserId: string) {
  await db.collection('employees').doc(employeeId).update({
    wheniworkUserId,
    updatedAt: new Date().toISOString(),
  });
}

// Maps a raw WIW shift payload into this app's local `shifts` document shape.
// TODO(verify against WIW docs): field names below (id/user_id/location_id/
// start_time/end_time/notes) are placeholders — confirm against the real
// webhook/API payload shape and adjust here (this is the one place that
// needs updating).
async function mapWiwShiftToLocalDoc(wiwShift: any) {
  const wheniworkUserId = wiwShift.user_id ?? wiwShift.userId ?? null;
  const employeeId = await resolveEmployeeIdForWiwUser(wheniworkUserId);
  const notes = wiwShift.notes ?? wiwShift.description ?? '';

  return {
    wheniworkShiftId: String(wiwShift.id),
    wheniworkUserId: wheniworkUserId ? String(wheniworkUserId) : null,
    employeeId,
    wheniworkLocationId: wiwShift.location_id ? String(wiwShift.location_id) : null,
    siteId: null, // best-effort; resolved separately once WIW location <-> site mapping is confirmed
    start: wiwShift.start_time ?? wiwShift.start ?? null,
    end: wiwShift.end_time ?? wiwShift.end ?? null,
    notes,
    isInserviceShift: isInserviceNotes(notes),
    status: wheniworkUserId ? 'assigned' : 'open',
    raw: wiwShift,
  };
}

// Core webhook-handling logic — a pure function taking parsed event data, no
// Express req/res, so it's directly unit-testable. Upserts by
// wheniworkShiftId, which also makes duplicate webhook deliveries safe
// (calling this twice with the same payload is a no-op the second time).
async function upsertShiftFromWebhookEvent(eventType: string, wiwShiftPayload: any) {
  const wheniworkShiftId = String(wiwShiftPayload.id);
  const existingSnapshot = await db.collection('shifts')
    .where('wheniworkShiftId', '==', wheniworkShiftId)
    .limit(1)
    .get();
  const existingDoc = existingSnapshot.empty ? null : existingSnapshot.docs[0];
  const now = new Date().toISOString();

  if (eventType === 'shift.deleted' || eventType === 'deleted') {
    if (!existingDoc) return null; // nothing to mark deleted
    await existingDoc.ref.update({ status: 'deleted', deletedAt: now, updatedAt: now });
    return existingDoc.id;
  }

  const mapped = await mapWiwShiftToLocalDoc(wiwShiftPayload);

  if (existingDoc) {
    await existingDoc.ref.update({ ...mapped, updatedAt: now });
    return existingDoc.id;
  }

  const docRef = await db.collection('shifts').add({
    ...mapped,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return docRef.id;
}

class ShiftPickupError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Claims an open shift for an employee: atomically flips the local doc to
// 'assigned' inside a Firestore transaction (first transaction usage in this
// codebase — the standard idiom for preventing two employees from claiming
// the same shift), then pushes the assignment to WIW. If WIW rejects it, the
// local claim is reverted so this app's state never says "assigned" when WIW
// disagrees.
async function pickUpShift(shiftId: string, employeeId: string) {
  const employeeDoc = await db.collection('employees').doc(employeeId).get();
  if (!employeeDoc.exists) {
    throw new ShiftPickupError(404, 'Employee not found');
  }
  const employee = employeeDoc.data();
  if (!employee?.wheniworkUserId) {
    throw new ShiftPickupError(409, "Your account isn't linked to When I Work yet — contact your supervisor.");
  }

  const shiftRef = db.collection('shifts').doc(shiftId);
  let wheniworkShiftId: string;

  await db.runTransaction(async (transaction: any) => {
    const shiftDoc = await transaction.get(shiftRef);
    if (!shiftDoc.exists) {
      throw new ShiftPickupError(404, 'Shift not found');
    }
    const shift = shiftDoc.data();
    if (shift.status !== 'open') {
      throw new ShiftPickupError(409, 'This shift was already picked up.');
    }
    wheniworkShiftId = shift.wheniworkShiftId;
    transaction.update(shiftRef, {
      status: 'assigned',
      employeeId,
      updatedAt: new Date().toISOString(),
    });
  });

  try {
    await assignShiftToUser(wheniworkShiftId!, employee.wheniworkUserId);
  } catch (err: any) {
    // WIW rejected the assignment (e.g. it was claimed there by another
    // means first) — revert the local claim rather than leaving this app's
    // state out of sync with the real source of truth. Best-effort: if this
    // update itself fails, a later webhook re-sync will still correct it.
    await shiftRef.update({ status: 'open', employeeId: null, updatedAt: new Date().toISOString() }).catch((revertErr: any) => {
      console.error(`[wheniwork] Failed to revert shift ${shiftId} after WIW assignment failure:`, revertErr);
    });
    console.error(`[wheniwork] WIW rejected shift assignment for shift ${shiftId}:`, err);
    throw new ShiftPickupError(502, 'Could not confirm this shift with When I Work — please try again.');
  }

  return { shiftId, employeeId };
}

export {
  isInserviceNotes,
  mapWiwShiftToLocalDoc,
  resolveEmployeeIdForWiwUser,
  linkEmployeeToWiwUser,
  upsertShiftFromWebhookEvent,
  pickUpShift,
  ShiftPickupError,
};
