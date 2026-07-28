export {};
const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const moment = require('moment');
const { requireRole } = require('../middleware/requireRole');
import { performCloseOut } from '../services/sessionCloseOutService';

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
    const { date, location, startTime, endTime, length, topics, trainer, trainees, sheetImageUrls } = req.body;
    const topicsArray = Array.isArray(topics) ? topics : (topics ? [topics] : []);
    const trainerIds = Array.isArray(trainer) ? trainer : (trainer ? [trainer] : []);
    const traineeList = Array.isArray(trainees) ? trainees : [];

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
      sheetImageUrls: Array.isArray(sheetImageUrls) ? sheetImageUrls : [],
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
// location/trainer ids), no employee PII.
router.get('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionDoc = await db.collection('sessions').doc(sessionId).get();

    if (!sessionDoc.exists) {
      return res.status(404).json({ message: 'Session not found' });
    }

    res.json({ id: sessionDoc.id, ...sessionDoc.data() });
  } catch (error) {
    console.error('Error getting session:', error);
    res.status(500).json({ error: 'Failed to get session' });
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

// Get all sessions
router.get('/', requireRole(STAFF), async (req, res) => {
  try {
    const sessionsSnapshot = await db.collection('sessions').get();
    const sessions = [];

    sessionsSnapshot.forEach(doc => {
      sessions.push({ id: doc.id, ...doc.data() });
    });

    res.json(sessions);
  } catch (error) {
    console.error('Error getting sessions:', error);
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

export default router;
