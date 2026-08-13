export {};
const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const moment = require('moment');
const { requireRole } = require('../middleware/requireRole');
import { performCloseOut } from '../services/sessionCloseOutService';
import { findDuplicateSheetSession } from '../services/sheetDuplicateCheck';
import { getSignedSheetImageUrl } from '../config/r2';
import { parseLocalDate } from '../utils/dateParsing';
import { getMandatoryTopicsForDate } from '../services/mandatoryTopicsService';

const STAFF = ['supervisor', 'trainer'];

// Create a new training session (standalone, not tied to specific employee)
router.post('/', requireRole(STAFF), async (req, res) => {
  try {
    const { date, location, startTime, length, topics, trainer, trainees, name } = req.body;
    const topicsArray = Array.isArray(topics) ? topics : (topics ? [topics] : []);

    const missingFields = [];
    if (!date) missingFields.push('date');
    if (!location) missingFields.push('location');
    if (topicsArray.length === 0) missingFields.push('topics');
    if (!trainer) missingFields.push('trainer');

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: {
          message: 'Validation Error',
          details: missingFields.map((field) => ({ path: [field], message: `${field} is required` }))
        }
      });
    }

    // Whichever topics are mandatory for this date's week (see
    // mandatoryTopicsService) must be included — this is the real
    // enforcement boundary; the Add Training UI locking them from removal
    // is just the client-side convenience on top of this.
    const { topics: mandatoryTopics } = await getMandatoryTopicsForDate(date);
    const missingMandatory = mandatoryTopics.filter((t: string) => !topicsArray.includes(t));
    if (missingMandatory.length > 0) {
      return res.status(400).json({
        error: {
          message: `The following mandatory topic(s) for this week must be included: ${missingMandatory.join(', ')}`,
          missingMandatoryTopics: missingMandatory,
        }
      });
    }

    const sessionData = {
      name: name || topicsArray.join(', '),
      date,
      location,
      startTime: startTime || '',
      length: typeof length === 'number' ? length : parseInt(length, 10) || 0,
      topics: topicsArray,
      trainer: Array.isArray(trainer) ? trainer : [trainer],
      trainees: Array.isArray(trainees) ? trainees : [],
      status: 'scheduled',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const docRef = await db.collection('sessions').add(sessionData);

    res.status(201).json({
      message: 'Training session created',
      sessionId: docRef.id,
      session: { id: docRef.id, ...sessionData }
    });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Create a session from an uploaded (already-completed) sign-in sheet, and
// immediately close it out using the sheet's own recorded start/end time —
// reuses the exact same crediting logic as a live close-out, so an imported
// sheet produces a session doc, per-employee/trainer credited hours, and a
// trainer field (employee IDs) all identical in shape to one entered through
// Add Training. This is what makes Upload Sheet sessions show up in the same
// Training Sessions list and count correctly toward hour totals.
router.post('/from-sheet', requireRole(STAFF), async (req, res) => {
  try {
    const { date, location, startTime, endTime, length, topics, trainer, trainees, sheetImageKeys, sheetImageHashes, flaggedAsPossibleDuplicateOf } = req.body;
    const topicsArray = Array.isArray(topics) ? topics : (topics ? [topics] : []);
    const trainerIds = Array.isArray(trainer) ? trainer : (trainer ? [trainer] : []);
    const traineeList = Array.isArray(trainees) ? trainees : [];
    const hashList = Array.isArray(sheetImageHashes) ? sheetImageHashes : [];

    const missingFields = [];
    if (!date) missingFields.push('date');
    if (!location) missingFields.push('location');
    if (topicsArray.length === 0) missingFields.push('topics');
    if (trainerIds.length === 0) missingFields.push('trainer');
    if (traineeList.length === 0) missingFields.push('trainees');

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: {
          message: 'Validation Error',
          details: missingFields.map((field) => ({ path: [field], message: `${field} is required` }))
        }
      });
    }

    // Re-verify at the actual hour-crediting commit point, not just at OCR
    // extraction time — closes the gap where a review screen sat open long
    // enough for the same sheet to already get submitted another way.
    const duplicate = await findDuplicateSheetSession(hashList);
    if (duplicate) {
      return res.status(409).json({
        error: {
          message: `This sign-in sheet was already uploaded and credited — it matches the session on ${duplicate.date || 'an earlier date'} at ${duplicate.location || 'an unknown location'}. If this is a correction, edit that session instead of uploading it again.`,
          duplicateSessionId: duplicate.sessionId,
        },
      });
    }

    const sessionData = {
      name: topicsArray.join(', '),
      date,
      location,
      startTime: startTime || '',
      endTime: endTime || '',
      length: typeof length === 'number' ? length : parseFloat(length) || 0,
      topics: topicsArray,
      trainer: trainerIds,
      trainees: traineeList.map((t: any) => t.employeeId),
      status: 'scheduled',
      source: 'upload-sheet',
      sheetImageKeys: Array.isArray(sheetImageKeys) ? sheetImageKeys : [],
      sheetImageHashes: hashList,
      // Set only when the uploader was warned about a likely-similar existing
      // session (see findSimilarSheetSession) and chose to save anyway —
      // informational, so it can be surfaced to a supervisor reviewing
      // Completed Trainings, never used to block saving.
      flaggedAsPossibleDuplicateOf: flaggedAsPossibleDuplicateOf || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const sessionRef = await db.collection('sessions').add(sessionData);

    // One checkin per attendee, timestamped to the sheet's own start time —
    // this is what performCloseOut uses to compute each employee's hours.
    const checkinTimeIso = (() => {
      const parsed = moment(`${date} ${startTime || ''}`.trim(), ['YYYY-MM-DD hh:mm A', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD']);
      return (parsed.isValid() ? parsed : moment(date)).toISOString();
    })();

    const batch = db.batch();
    for (const t of traineeList) {
      if (!t.employeeId) continue;
      const checkinRef = db.collection('checkins').doc();
      batch.set(checkinRef, {
        sessionId: sessionRef.id,
        employeeId: t.employeeId,
        badgeNumber: t.badgeNumber || '',
        name: t.name || '',
        email: t.email || '',
        location,
        checkinTime: checkinTimeIso,
      });
    }
    await batch.commit();

    const closeOutTime = (() => {
      if (endTime) {
        const parsed = moment(`${date} ${endTime}`.trim(), ['YYYY-MM-DD hh:mm A', 'YYYY-MM-DD HH:mm']);
        if (parsed.isValid()) return parsed.toDate();
      }
      // No recorded end time — fall back to start time + the sheet's stated length.
      const start = moment(checkinTimeIso);
      const hrs = typeof length === 'number' ? length : parseFloat(length) || 1;
      return start.add(hrs, 'hours').toDate();
    })();

    const result = await performCloseOut(sessionRef.id, { closeOutTime });

    res.status(201).json({
      message: 'Session imported and closed out successfully',
      sessionId: sessionRef.id,
      ...result,
    });
  } catch (error: any) {
    console.error('Error creating session from sheet:', error);
    res.status(error.statusCode || 500).json({ error: { message: error.message || 'Failed to create session from sheet' } });
  }
});

// Get a specific session by ID — stays public: the QR check-in page
// (src/pages/checkin/[sessionId].js) fetches this before the visitor has
// identified themselves at all. Only exposes session metadata (topic/date/
// location/trainer ids), no employee PII — sheetImageKeys is stripped so the
// raw R2 object keys backing this session's sign-in sheet photos never reach
// an unauthenticated caller (viewing them requires GET /:sessionId/images).
router.get('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionDoc = await db.collection('sessions').doc(sessionId).get();

    if (!sessionDoc.exists) {
      return res.status(404).json({ message: 'Session not found' });
    }

    const { sheetImageKeys, ...publicData } = sessionDoc.data() as any;
    res.json({ id: sessionDoc.id, ...publicData });
  } catch (error) {
    console.error('Error getting session:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// Signed, short-lived URLs for a session's sign-in sheet photos — the R2
// bucket is private and sheetImageKeys are never sent to the client directly
// (see the public GET /:sessionId above), so viewing a sheet always goes
// through this authenticated route instead of a link that could be shared
// or cached indefinitely.
router.get('/:sessionId/images', requireRole(STAFF), async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionDoc = await db.collection('sessions').doc(sessionId).get();

    if (!sessionDoc.exists) {
      return res.status(404).json({ message: 'Session not found' });
    }

    const keys: string[] = sessionDoc.data()?.sheetImageKeys || [];
    const urls = await Promise.all(
      keys.map((key) => getSignedSheetImageUrl(key))
    );

    res.json({ urls });
  } catch (error) {
    console.error('Error getting session images:', error);
    res.status(500).json({ error: 'Failed to get session images' });
  }
});

// Signed, short-lived URL for a session's generated in-service sign-in sheet
// docx — same posture as GET /:sessionId/images above (the R2 key is never
// sent to the client directly; GET / below exposes only a boolean).
router.get('/:sessionId/inservice-sheet', requireRole(STAFF), async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionDoc = await db.collection('sessions').doc(sessionId).get();

    if (!sessionDoc.exists) {
      return res.status(404).json({ message: 'Session not found.' });
    }

    const key = sessionDoc.data()?.inserviceSheetKey;
    if (!key) {
      return res.status(404).json({ message: 'No in-service sheet has been generated for this session.' });
    }

    res.json({ url: await getSignedSheetImageUrl(key) });
  } catch (error) {
    console.error('Error getting in-service sheet:', error);
    res.status(500).json({ error: 'Failed to get in-service sheet' });
  }
});

// Update a session (e.g., add trainees manually)
router.put('/:sessionId', requireRole(STAFF), async (req, res) => {
  try {
    const { sessionId } = req.params;
    const updateData = req.body;

    const sessionDoc = await db.collection('sessions').doc(sessionId);
    const doc = await sessionDoc.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Session not found' });
    }

    const normalizedUpdateData = { ...updateData };
    if (normalizedUpdateData.trainer !== undefined) {
      normalizedUpdateData.trainer = Array.isArray(normalizedUpdateData.trainer)
        ? normalizedUpdateData.trainer
        : [normalizedUpdateData.trainer];
    }

    if (normalizedUpdateData.trainees !== undefined) {
      normalizedUpdateData.trainees = Array.isArray(normalizedUpdateData.trainees)
        ? normalizedUpdateData.trainees
        : [normalizedUpdateData.trainees];
    }

    normalizedUpdateData.updatedAt = new Date().toISOString();
    await sessionDoc.update(normalizedUpdateData);

    const updatedDoc = await sessionDoc.get();
    res.json({
      message: 'Session updated',
      session: { id: sessionId, ...updatedDoc.data(), ...normalizedUpdateData }
    });
  } catch (error) {
    console.error('Error updating session:', error);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// Close out a session: credits every checked-in employee with hours (from their
// individual check-in time to the moment of close-out), and credits every trainer
// on the session with hours led (from the session's effective start to close-out).
router.post('/:sessionId/close', requireRole(STAFF), async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await performCloseOut(sessionId);
    res.json({ message: 'Session closed out successfully', ...result });
  } catch (error: any) {
    console.error('Error closing out session:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to close out session' });
  }
});

// Get all sessions — optionally narrowed by status/date range/location.
// All three filters are additive and optional (existing callers that pass
// none of them, like the manager dashboard, keep getting everything back
// unfiltered, then narrow client-side same as before).
router.get('/', requireRole(STAFF), async (req: any, res) => {
  try {
    const { status, startDate, endDate, workSite } = req.query;
    const sessionsSnapshot = await db.collection('sessions').get();
    const sessions: any[] = [];

    const dateStart = parseLocalDate(startDate);
    const dateEnd = parseLocalDate(endDate);
    const sites: string[] | null = workSite && workSite !== 'all'
      ? String(workSite).split(',').map((s: string) => s.trim()).filter(Boolean)
      : null;

    sessionsSnapshot.forEach(doc => {
      const { sheetImageKeys, inserviceSheetKey, ...rest } = doc.data() as any;
      const session: any = {
        id: doc.id, ...rest,
        sheetImageCount: Array.isArray(sheetImageKeys) ? sheetImageKeys.length : 0,
        hasInserviceSheet: !!inserviceSheetKey,
      };
      if (status && session.status !== status) return;
      if (dateStart || dateEnd) {
        const sessionDate = parseLocalDate(session.date);
        if (!sessionDate) return;
        if (dateStart && sessionDate < dateStart) return;
        if (dateEnd && sessionDate > dateEnd) return;
      }
      if (sites && !sites.includes(session.location)) return;
      sessions.push(session);
    });

    res.json(sessions);
  } catch (error) {
    console.error('Error getting sessions:', error);
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

export default router;
