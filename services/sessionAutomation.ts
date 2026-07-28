import { db } from '../config/firebase';
import { getScheduledEndTime, performCloseOut } from './sessionCloseOutService';
import { sendEmail, closeOutReminderTemplate } from './messagingService';

const REMINDER_DELAY_MS = 5 * 60 * 1000;        // remind the trainer 5 min after scheduled end
const AUTO_CLOSE_DELAY_MS = 24 * 60 * 60 * 1000; // auto-close 24h after scheduled end if still open
// No real in-service session runs this long — a listed duration beyond this
// means the data is wrong (e.g. a unit-conversion bug, or a bad manual
// entry), not a legitimately long session. Auto-close must never blindly
// credit a number like that; it's safer to leave it open for a supervisor
// to look at than to silently hand out a day's worth of bogus hours.
const MAX_PLAUSIBLE_LENGTH_HOURS = 12;

// Polled periodically (see app.ts). Only ever looks at 'scheduled' sessions —
// Upload Sheet imports are always created already-completed, so they never
// show up here. A session with no parseable date/startTime/length is
// skipped entirely rather than guessed at.
export async function runSessionAutomationCheck() {
  const snapshot = await db.collection('sessions').where('status', '==', 'scheduled').get();
  const now = new Date();

  for (const doc of snapshot.docs) {
    const session: any = { id: doc.id, ...doc.data() };
    const scheduledEnd = getScheduledEndTime(session);
    if (!scheduledEnd) continue;

    const msSinceScheduledEnd = now.getTime() - scheduledEnd.getTime();

    if (msSinceScheduledEnd >= AUTO_CLOSE_DELAY_MS) {
      await autoCloseSession(session, scheduledEnd);
      continue;
    }

    if (msSinceScheduledEnd >= REMINDER_DELAY_MS && !session.reminderSentAt) {
      await sendCloseOutReminder(session);
    }
  }
}

async function autoCloseSession(session: any, scheduledEnd: Date) {
  const lengthHours = typeof session.length === 'number' ? session.length : parseFloat(session.length) || 0;

  if (lengthHours <= 0 || lengthHours > MAX_PLAUSIBLE_LENGTH_HOURS) {
    console.warn(`[session-automation] Session ${session.id} has an implausible listed length (${lengthHours}h) — skipping auto-close for a supervisor to review instead of crediting it blindly.`);
    return;
  }

  try {
    await performCloseOut(session.id, { closeOutTime: scheduledEnd, fixedDurationHours: lengthHours });
    console.log(`[session-automation] Auto-closed session ${session.id} using listed duration (${lengthHours}h) — trainer never closed it out.`);
  } catch (err: any) {
    // "already completed" can legitimately race with a trainer closing it out
    // between the query and this call — not worth logging as an error.
    if (err.statusCode !== 400) {
      console.error(`[session-automation] Failed to auto-close session ${session.id}:`, err.message);
    }
  }
}

async function sendCloseOutReminder(session: any) {
  const trainerIds: string[] = Array.isArray(session.trainer) ? session.trainer : (session.trainer ? [session.trainer] : []);
  let sentToAny = false;

  for (const trainerId of trainerIds) {
    try {
      const trainerDoc = await db.collection('employees').doc(trainerId).get();
      if (!trainerDoc.exists) continue;
      const trainer: any = trainerDoc.data();
      if (!trainer.email) continue;

      await sendEmail(
        trainer.email,
        'Close out your training session',
        closeOutReminderTemplate(trainer.name, session)
      );
      sentToAny = true;
    } catch (err: any) {
      console.error(`[session-automation] Failed to email trainer ${trainerId} for session ${session.id}:`, err.message);
    }
  }

  // Mark as attempted regardless of per-trainer delivery success, so a
  // missing/bad email doesn't cause a resend attempt every polling cycle —
  // the session will still reach the 24h auto-close either way.
  await db.collection('sessions').doc(session.id).update({
    reminderSentAt: new Date().toISOString(),
  });

  if (sentToAny) {
    console.log(`[session-automation] Sent close-out reminder for session ${session.id}`);
  } else {
    console.warn(`[session-automation] No trainer email on file for session ${session.id} — reminder not actually sent`);
  }
}
