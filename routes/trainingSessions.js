const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

// Get all training sessions
router.get('/', async (req, res) => {
  try {
    const allSessions = [];
    const employeesSnapshot = await db.collection('employees').get();

    for (const employeeDoc of employeesSnapshot.docs) {
      const sessionsSnapshot = await employeeDoc.ref.collection('trainingSessions').get();
      
      sessionsSnapshot.forEach(sessionDoc => {
        const session = sessionDoc.data();
        allSessions.push({
          id: sessionDoc.id,
          topic: session.topic,
          trainer: session.trainer,
          date: session.date,
          participants: session.trainees ? session.trainees.length : 0,
          status: session.status || 'completed'
        });
      });
    }

    res.json(allSessions);
  } catch (error) {
    console.error('Error getting training sessions:', error);
    res.status(500).json({ error: 'Failed to get training sessions' });
  }
});

// Add a new training session for an employee
router.post('/:employeeId', async (req, res) => {
  try {
    const { date, location, startTime, length, topic, trainer, trainees } = req.body;
    const { employeeId } = req.params;

    // Check if employee exists
    const employeeDoc = await db.collection('employees').doc(employeeId).get();
    if (!employeeDoc.exists) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const sessionData = {
      date,
      location,
      startTime,
      length,
      topic,
      trainer,
      trainees,
      status: 'completed',
      createdAt: new Date().toISOString()
    };

    // Add the session to the employee's trainingSessions subcollection
    const docRef = await db
      .collection('employees')
      .doc(employeeId)
      .collection('trainingSessions')
      .add(sessionData);

    // Update employee's total hours
    const currentHours = employeeDoc.data().totalHours || 0;
    await db
      .collection('employees')
      .doc(employeeId)
      .update({
        totalHours: currentHours + parseFloat(length),
        updatedAt: new Date().toISOString()
      });

    res.status(201).json({ 
      message: 'Training session added', 
      sessionId: docRef.id, 
      session: { id: docRef.id, ...sessionData }
    });
  } catch (error) {
    console.error('Error adding training session:', error);
    res.status(500).json({ error: 'Failed to add training session' });
  }
});

// Get training sessions for a specific employee
router.get('/employee/:employeeId', async (req, res) => {
  try {
    const { employeeId } = req.params;

    // Check if employee exists
    const employeeDoc = await db.collection('employees').doc(employeeId).get();
    if (!employeeDoc.exists) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const sessionsSnapshot = await db
      .collection('employees')
      .doc(employeeId)
      .collection('trainingSessions')
      .get();

    const sessions = [];
    sessionsSnapshot.forEach(doc => {
      const session = doc.data();
      sessions.push({
        id: doc.id,
        topic: session.topic,
        trainer: session.trainer,
        date: session.date,
        participants: session.trainees ? session.trainees.length : 0,
        status: session.status || 'completed'
      });
    });

    res.json(sessions);
  } catch (error) {
    console.error('Error getting employee training sessions:', error);
    res.status(500).json({ error: 'Failed to get employee training sessions' });
  }
});

// Add more endpoints as needed (e.g., update, delete session)

module.exports = router; 