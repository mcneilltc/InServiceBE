const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

// Create a new training session (standalone, not tied to specific employee)
router.post('/', async (req, res) => {
  try {
    const { date, location, startTime, length, topic, trainer, name } = req.body;

    if (!date || !location || !topic || !trainer || !name) {
      return res.status(400).json({ message: 'Required fields missing' });
    }

    const sessionData = {
      name,
      date,
      location,
      startTime: startTime || '',
      length: length || 0,
      topic,
      trainer,
      trainees: [],
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

// Get a specific session by ID
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
router.put('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const updateData = req.body;

    const sessionDoc = await db.collection('sessions').doc(sessionId);
    const doc = await sessionDoc.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Session not found' });
    }

    updateData.updatedAt = new Date().toISOString();
    await sessionDoc.update(updateData);

    res.json({
      message: 'Session updated',
      session: { id: sessionId, ...doc.data(), ...updateData }
    });
  } catch (error) {
    console.error('Error updating session:', error);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// Get all sessions
router.get('/', async (req, res) => {
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

module.exports = router;

