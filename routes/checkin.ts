export {};
const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
import { selfCheckin } from '../controllers/checkinController';

router.post('/', async (req, res) => {
  const { sessionId, name, email, phone, location } = req.body;

  if (!sessionId || !name || !email || !phone || !location) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

//   try {
//     // Save check-in data to Firestore
//     const checkinData = {
//       sessionId,
//       name,
//       email,
//       phone,
//       location,
//       checkinTime: new Date().toISOString(),
//     };

//     await db.collection('checkins').add(checkinData);

//     res.status(200).json({ message: 'Check-in successful.' });
//   } catch (error) {
//     console.error('Error saving check-in:', error);
//     res.status(500).json({ message: 'Failed to save check-in.' });
//   }
try {
    // Save check-in data to Firestore
    const checkinData = {
      sessionId,
      name,
      email,
      phone,
      location,
      checkinTime: new Date().toISOString(),
    };

    const docRef = await db.collection('checkins').add(checkinData);

    // Fetch session details for the response
    const sessionDoc = await db.collection('sessions').doc(sessionId).get();
    if (!sessionDoc.exists) {
      return res.status(404).json({ message: 'Session not found.' });
    }

    const sessionData = sessionDoc.data();

    // Construct the response object
    const response = {
      id: sessionId,
      name: sessionData.name || 'Unknown Session',
      date: sessionData.date || new Date().toISOString().split('T')[0], // Default to today's date
      trainer: sessionData.trainer || 'Unknown Trainer',
      trainees: sessionData.trainees || [], // Default to an empty array
    };

    res.status(200).json(response);
  } catch (error) {
    console.error('Error saving check-in:', error);
    res.status(500).json({ message: 'Failed to save check-in.' });
  }
});

// Self check-in using QR token + badge + firstName/lastName
router.post('/self', (req, res, next) => {
  return (selfCheckin as any)(req, res, next);
});

// Get all check-ins
router.get('/', async (req, res) => {
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