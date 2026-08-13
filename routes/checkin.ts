export {};
const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { requireRole } = require('../middleware/requireRole');
const { clampSitesToScope } = require('../services/authService');
const moment = require('moment');
import { selfCheckin } from '../controllers/checkinController';
import { uploadSignature } from '../services/signatureStorage';

// Self check-in via the electronic form closes this long after the session's
// scheduled start — after that, a trainer must add a late employee manually
// (the { employeeId } path below), since the trainer is vouching for them.
const SELF_CHECKIN_GRACE_MINUTES = 1;

// POST /api/checkin
// Two ways to identify the employee:
//  - { sessionId, employeeId } — trusted, used by the "manually add employee" admin flow
//  - { sessionId, badgeNumber, firstName, lastName } — public QR self check-in flow
router.post('/', async (req, res) => {
  const { sessionId, employeeId, badgeNumber, firstName, lastName, signature } = req.body;

  if (!sessionId) {
    return res.status(400).json({ message: 'sessionId is required.' });
  }
  if (!employeeId && !(badgeNumber && firstName && lastName)) {
    return res.status(400).json({ message: 'Provide either employeeId, or badgeNumber + firstName + lastName.' });
  }

  try {
    const sessionDoc = await db.collection('sessions').doc(sessionId).get();
    if (!sessionDoc.exists) {
      return res.status(404).json({ message: 'Session not found.' });
    }
    const sessionData = sessionDoc.data();
    if (sessionData.status === 'completed') {
      return res.status(400).json({ message: 'This training session has already been closed out.' });
    }

    // Only the self check-in path (no trusted employeeId) is time-gated —
    // a trainer manually adding a late employee is unaffected.
    if (!employeeId && sessionData.startTime) {
      const scheduledStart = moment(
        `${sessionData.date} ${sessionData.startTime}`.trim(),
        ['YYYY-MM-DD hh:mm A', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD'],
        true
      );
      if (scheduledStart.isValid()) {
        const cutoff = scheduledStart.clone().add(SELF_CHECKIN_GRACE_MINUTES, 'minutes');
        if (moment().isAfter(cutoff)) {
          return res.status(403).json({
            message: `Self check-in has closed — it's only available within ${SELF_CHECKIN_GRACE_MINUTES} minute(s) of the session's start time. Ask your trainer to add you manually.`,
          });
        }
      }
    }

    let employeeDoc;
    if (employeeId) {
      employeeDoc = await db.collection('employees').doc(employeeId).get();
      if (!employeeDoc.exists) {
        return res.status(404).json({ message: 'Employee not found.' });
      }
    } else {
      const badgeTrim = String(badgeNumber).trim();
      const providedFirst = String(firstName).trim().toLowerCase();
      const providedLast = String(lastName).trim().toLowerCase();

      const empSnap = await db.collection('employees').where('badgeNumber', '==', badgeTrim).get();
      if (empSnap.empty) {
        return res.status(404).json({ message: 'No employee found with that badge number.' });
      }

      for (const doc of empSnap.docs) {
        const d = doc.data();
        const storedFirst = (d.firstName || '').toLowerCase();
        const storedLast = (d.lastName || '').toLowerCase();
        const [legacyFirst = '', ...legacyLastParts] = (d.name || '').toLowerCase().split(' ');
        const legacyLast = legacyLastParts.join(' ');
        const firstMatch = storedFirst === providedFirst || legacyFirst === providedFirst;
        const lastMatch = storedLast === providedLast || legacyLast === providedLast;
        if (firstMatch && lastMatch) {
          employeeDoc = doc;
          break;
        }
      }

      if (!employeeDoc) {
        return res.status(403).json({ message: 'Badge number and name do not match our records.' });
      }
    }

    const empId = employeeDoc.id;
    const employeeData = employeeDoc.data();

    // Duplicate check: same employee, same session
    const dupQuery = await db.collection('checkins')
      .where('sessionId', '==', sessionId)
      .where('employeeId', '==', empId)
      .get();
    if (!dupQuery.empty) {
      return res.status(409).json({ message: 'This employee has already checked in for this session.' });
    }

    const checkinData: any = {
      sessionId,
      employeeId: empId,
      badgeNumber: employeeData.badgeNumber || null,
      name: employeeData.name || `${employeeData.firstName || ''} ${employeeData.lastName || ''}`.trim(),
      email: employeeData.email || '',
      // The check-in's location is where the training physically happened —
      // the session's own location — not the employee's home site. Those are
      // deliberately different things: an employee's home site can supervise
      // scoping, but this field is what lets "where did my staff train" work.
      location: sessionData.location || (employeeData.locations && employeeData.locations[0]) || employeeData.location || '',
      checkinTime: new Date().toISOString(),
    };

    // Pre-allocate the doc ref so its ID is known before writing — the
    // employee's signature (if provided) is stored in R2 keyed by this ID.
    const docRef = db.collection('checkins').doc();
    if (signature) {
      checkinData.signatureKey = await uploadSignature(sessionId, docRef.id, signature);
    }
    await docRef.set(checkinData);

    res.status(200).json({
      id: docRef.id,
      checkin: checkinData,
      session: {
        id: sessionId,
        name: sessionData.name || (sessionData.topics && sessionData.topics.join(', ')) || sessionData.topic || 'Training Session',
        date: sessionData.date || new Date().toISOString().split('T')[0],
        trainer: sessionData.trainer || 'Unknown Trainer',
        trainees: sessionData.trainees || [],
      },
    });
  } catch (error) {
    console.error('Error saving check-in:', error);
    res.status(500).json({ message: 'Failed to save check-in.' });
  }
});

// Self check-in using QR token + badge + firstName/lastName
router.post('/self', (req, res, next) => {
  return (selfCheckin as any)(req, res, next);
});

// Get all check-ins — supervisor only (manager dashboard)
//
// Scoping is by the checked-in employee's *home* location, not the check-in's
// own location — a supervisor of ERRC should see all their ERRC-homebased
// staff's check-ins regardless of where those check-ins happened, so they can
// tell what other locations their people train at. The `location` param
// narrows those results down to a specific training location; `homeSite`
// (only meaningful for an all-site supervisor, or one scoped to several
// sites) narrows the roster itself to one home site.
router.get('/', requireRole(['supervisor']), async (req: any, res) => {
  try {
    const { location, homeSite } = req.query;

    const employeesSnapshot = await db.collection('employees').get();
    const homeLocationById: Record<string, string> = {};
    employeesSnapshot.forEach((doc: any) => {
      homeLocationById[doc.id] = doc.data().homeLocation || '';
    });

    const clientRequestedHomeSites: string[] | null = homeSite
      ? String(homeSite).split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    const requestedHomeSites = clampSitesToScope(req.user, clientRequestedHomeSites);

    const requestedLocations: string[] | null = location
      ? String(location).split(',').map((s) => s.trim()).filter(Boolean)
      : null;

    const checkinsSnapshot = await db.collection('checkins').get();
    let checkins: any[] = [];
    checkinsSnapshot.forEach((doc: any) => {
      checkins.push({ id: doc.id, ...doc.data() });
    });

    if (requestedHomeSites) {
      checkins = checkins.filter((c) => requestedHomeSites.includes(homeLocationById[c.employeeId]));
    }
    if (requestedLocations) {
      checkins = checkins.filter((c) => requestedLocations.includes(c.location));
    }

    // Sort by check-in time (most recent first)
    checkins.sort((a: any, b: any) => {
      const timeA = new Date(a.checkinTime).getTime();
      const timeB = new Date(b.checkinTime).getTime();
      return timeB - timeA;
    });

    res.json(checkins);
  } catch (error) {
    console.error('Error getting check-ins:', error);
    res.status(500).json({ error: 'Failed to get check-ins' });
  }
});

export default router;