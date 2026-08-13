import { db } from '../config/firebase';
import * as admin from 'firebase-admin';
import moment from 'moment';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, getBucketName } from '../config/r2';
import { generateInserviceSheet } from './inserviceSheetService';

// The scheduled end of a session: date + startTime + length (hours). Used to
// decide when a reminder or auto-close is due, and as the auto-close's
// closedAt/effective-end timestamp (since "now", whenever the automation
// happens to notice, isn't when the session actually ended).
export function getScheduledEndTime(session: any): Date | null {
  if (!session.date) return null;
  const parsed = moment(`${session.date} ${session.startTime || ''}`.trim(), ['YYYY-MM-DD hh:mm A', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD']);
  if (!parsed.isValid()) return null;
  const lengthHours = typeof session.length === 'number' ? session.length : parseFloat(session.length) || 0;
  return parsed.add(lengthHours, 'hours').toDate();
}

interface CloseOutOptions {
  // Defaults to "now" — the real moment a live session is manually closed,
  // or a sheet's own recorded end time for an Upload Sheet import.
  closeOutTime?: Date;
  // When set, every checked-in employee AND every trainer is credited this
  // exact number of hours instead of hours computed from real timestamps.
  // Used only by the 24h auto-close: by then, real elapsed time (however
  // long a session sat open after everyone left) is meaningless — the
  // session's own planned/listed duration is the only trustworthy number.
  fixedDurationHours?: number;
}

// Shared close-out logic: credits every checked-in employee with hours (from
// their individual check-in time to closeOutTime, unless fixedDurationHours
// overrides that), and credits every trainer on the session with hours led.
// Used by the interactive "close out this live session now" route, the
// from-sheet import (sheet's own recorded end time), and the 24h auto-close
// (fixed listed duration).
export async function performCloseOut(sessionId: string, options: CloseOutOptions = {}) {
  const sessionRef = db.collection('sessions').doc(sessionId);
  const sessionDoc = await sessionRef.get();

  if (!sessionDoc.exists) {
    const err: any = new Error('Session not found');
    err.statusCode = 404;
    throw err;
  }

  const sessionData: any = sessionDoc.data();
  if (sessionData.status === 'completed') {
    const err: any = new Error('This session has already been closed out.');
    err.statusCode = 400;
    throw err;
  }

  const checkinsSnap = await db.collection('checkins').where('sessionId', '==', sessionId).get();
  const checkins = checkinsSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));

  const closeOutTime = options.closeOutTime || new Date();
  const fixedDurationHours = options.fixedDurationHours;

  // Effective session start = earliest check-in, else the scheduled date/startTime, else close-out time
  let effectiveStart = closeOutTime;
  const checkinTimes = checkins
    .map((c: any) => (c.checkinTime ? new Date(c.checkinTime) : null))
    .filter((d: Date | null): d is Date => !!d && !isNaN(d.getTime()));

  if (checkinTimes.length > 0) {
    effectiveStart = new Date(Math.min(...checkinTimes.map(d => d.getTime())));
  } else if (sessionData.date) {
    const parsed = moment(`${sessionData.date} ${sessionData.startTime || ''}`.trim(), ['YYYY-MM-DD hh:mm A', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD']);
    if (parsed.isValid()) {
      effectiveStart = parsed.toDate();
    }
  }

  const hoursBetween = (start: Date, end: Date) => {
    const hrs = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    return Math.max(0, Math.round(hrs * 100) / 100);
  };

  // Credit each checked-in employee
  let employeesCredited = 0;
  let totalEmployeeHours = 0;
  for (const checkin of checkins) {
    if (!checkin.employeeId) continue;

    const employeeRef = db.collection('employees').doc(checkin.employeeId);
    // A checkin can outlive the employee record it points to (e.g. the
    // employee was later deleted/archived-out) — skip it rather than let one
    // dangling reference abort crediting for everyone else on the session.
    const employeeSnap = await employeeRef.get();
    if (!employeeSnap.exists) {
      console.warn(`[close-out] Skipping checkin ${checkin.id} on session ${sessionId} — employee ${checkin.employeeId} no longer exists.`);
      continue;
    }

    const checkinTime = checkin.checkinTime ? new Date(checkin.checkinTime) : effectiveStart;
    const durationHours = fixedDurationHours != null ? fixedDurationHours : hoursBetween(checkinTime, closeOutTime);

    const trainingSessionData: any = {
      date: sessionData.date,
      location: checkin.location || sessionData.location,
      topics: sessionData.topics || (sessionData.topic ? [sessionData.topic] : []),
      trainer: sessionData.trainer,
      length: durationHours,
      status: 'completed',
      sourceSessionId: sessionId,
      sourceCheckinId: checkin.id,
      createdAt: new Date().toISOString(),
    };
    if (fixedDurationHours != null) trainingSessionData.autoClosed = true;

    await employeeRef.collection('trainingSessions').add(trainingSessionData);
    await employeeRef.update({
      totalHours: admin.firestore.FieldValue.increment(durationHours),
      updatedAt: new Date().toISOString(),
    });

    employeesCredited++;
    totalEmployeeHours += durationHours;
  }

  // Credit each trainer on the session
  const trainerIds: string[] = Array.isArray(sessionData.trainer)
    ? sessionData.trainer
    : (sessionData.trainer ? [sessionData.trainer] : []);
  const trainerDurationHours = fixedDurationHours != null ? fixedDurationHours : hoursBetween(effectiveStart, closeOutTime);

  let trainersCredited = 0;
  for (const trainerId of trainerIds) {
    const trainerRef = db.collection('employees').doc(trainerId);
    const trainerDoc = await trainerRef.get();
    if (!trainerDoc.exists) continue;

    const ledData: any = {
      date: sessionData.date,
      location: sessionData.location,
      topics: sessionData.topics || (sessionData.topic ? [sessionData.topic] : []),
      length: trainerDurationHours,
      employeeCount: employeesCredited,
      sourceSessionId: sessionId,
      createdAt: new Date().toISOString(),
    };
    if (fixedDurationHours != null) ledData.autoClosed = true;

    await trainerRef.collection('trainingSessionsLed').add(ledData);
    await trainerRef.update({
      totalHoursLed: admin.firestore.FieldValue.increment(trainerDurationHours),
      updatedAt: new Date().toISOString(),
    });

    trainersCredited++;
  }

  const sessionUpdate: any = {
    status: 'completed',
    closedAt: closeOutTime.toISOString(),
    effectiveStartTime: effectiveStart.toISOString(),
    creditsGranted: true,
    employeesCredited,
    updatedAt: new Date().toISOString(),
  };
  if (fixedDurationHours != null) {
    sessionUpdate.autoClosed = true;
    sessionUpdate.autoClosedAt = new Date().toISOString();
  }
  await sessionRef.update(sessionUpdate);

  // Best-effort: generate the filled-in in-service sign-in sheet now that
  // the session is completed. Hour-crediting above has already fully
  // committed, so a template/R2 problem here must degrade to "no sheet yet"
  // rather than ever blocking or rolling back close-out.
  try {
    const { buffer } = await generateInserviceSheet(sessionId);
    const key = `inservice-sheets/${moment(sessionData.date || closeOutTime).format('YYYY/MM')}/${sessionId}.docx`;
    await r2Client.send(new PutObjectCommand({
      Bucket: getBucketName(),
      Key: key,
      Body: buffer,
      ContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }));
    await sessionRef.update({ inserviceSheetKey: key });
  } catch (error) {
    console.warn(`[close-out] Failed to generate in-service sheet for session ${sessionId}:`, (error as Error).message);
  }

  return {
    employeesCredited,
    totalEmployeeHours: Math.round(totalEmployeeHours * 100) / 100,
    trainersCredited,
    trainerDurationHours,
  };
}
