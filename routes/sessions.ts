export {};
const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const admin = require('firebase-admin');
const moment = require('moment');
const { requireRole } = require('../middleware/requireRole');

const STAFF = ['supervisor', 'trainer'];

// Create a new training session (standalone, not tied to specific employee)
router.post('/', requireRole(STAFF), async (req, res) => {
  try {
    const { date, location, startTime, length, topic, trainer, trainees, name } = req.body;

    const missingFields = [];
    if (!date) missingFields.push('date');
    if (!location) missingFields.push('location');
    if (!topic) missingFields.push('topic');
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
      name: name || topic,
      date,
      location,
      startTime: startTime || '',
      length: typeof length === 'number' ? length : parseInt(length, 10) || 0,
      topic,
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
    const sessionRef = db.collection('sessions').doc(sessionId);
    const sessionDoc = await sessionRef.get();

    if (!sessionDoc.exists) {
      return res.status(404).json({ message: 'Session not found' });
    }

    const sessionData = sessionDoc.data();
    if (sessionData.status === 'completed') {
      return res.status(400).json({ message: 'This session has already been closed out.' });
    }

    const checkinsSnap = await db.collection('checkins').where('sessionId', '==', sessionId).get();
    const checkins = checkinsSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));

    const closeOutTime = new Date();

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
      const checkinTime = checkin.checkinTime ? new Date(checkin.checkinTime) : effectiveStart;
      const durationHours = hoursBetween(checkinTime, closeOutTime);

      const employeeRef = db.collection('employees').doc(checkin.employeeId);
      const trainingSessionData = {
        date: sessionData.date,
        location: checkin.location || sessionData.location,
        topic: sessionData.topic,
        trainer: sessionData.trainer,
        length: durationHours,
        status: 'completed',
        sourceSessionId: sessionId,
        sourceCheckinId: checkin.id,
        createdAt: new Date().toISOString(),
      };

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
    const trainerDurationHours = hoursBetween(effectiveStart, closeOutTime);

    let trainersCredited = 0;
    for (const trainerId of trainerIds) {
      const trainerRef = db.collection('trainers').doc(trainerId);
      const trainerDoc = await trainerRef.get();
      if (!trainerDoc.exists) continue;

      await trainerRef.collection('trainingSessionsLed').add({
        date: sessionData.date,
        location: sessionData.location,
        topic: sessionData.topic,
        length: trainerDurationHours,
        employeeCount: employeesCredited,
        sourceSessionId: sessionId,
        createdAt: new Date().toISOString(),
      });
      await trainerRef.update({
        totalHoursLed: admin.firestore.FieldValue.increment(trainerDurationHours),
        updatedAt: new Date().toISOString(),
      });

      trainersCredited++;
    }

    await sessionRef.update({
      status: 'completed',
      closedAt: closeOutTime.toISOString(),
      effectiveStartTime: effectiveStart.toISOString(),
      creditsGranted: true,
      employeesCredited,
      updatedAt: new Date().toISOString(),
    });

    res.json({
      message: 'Session closed out successfully',
      employeesCredited,
      totalEmployeeHours: Math.round(totalEmployeeHours * 100) / 100,
      trainersCredited,
      trainerDurationHours,
    });
  } catch (error) {
    console.error('Error closing out session:', error);
    res.status(500).json({ error: 'Failed to close out session' });
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

