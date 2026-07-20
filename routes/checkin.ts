export {};
const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { requireRole } = require('../middleware/requireRole');
import { selfCheckin } from '../controllers/checkinController';

// POST /api/checkin
// Two ways to identify the employee:
//  - { sessionId, employeeId } — trusted, used by the "manually add employee" admin flow
//  - { sessionId, badgeNumber, firstName, lastName } — public QR self check-in flow
router.post('/', async (req, res) => {
  const { sessionId, employeeId, badgeNumber, firstName, lastName } = req.body;

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

    const checkinData = {
      sessionId,
      employeeId: empId,
      badgeNumber: employeeData.badgeNumber || null,
      name: employeeData.name || `${employeeData.firstName || ''} ${employeeData.lastName || ''}`.trim(),
      email: employeeData.email || '',
      location: (employeeData.locations && employeeData.locations[0]) || employeeData.location || sessionData.location || '',
      checkinTime: new Date().toISOString(),
    };

    const docRef = await db.collection('checkins').add(checkinData);

    res.status(200).json({
      id: docRef.id,
      checkin: checkinData,
      session: {
        id: sessionId,
        name: sessionData.name || sessionData.topic || 'Training Session',
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
router.get('/', requireRole(['supervisor']), async (req, res) => {
  try {
    const checkinsSnapshot = await db.collection('checkins').get();
    const checkins = [];
    
    checkinsSnapshot.forEach(doc => {
      checkins.push({ id: doc.id, ...doc.data() });
    });
    
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