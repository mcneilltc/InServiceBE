export {};
const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

// Get admin whitelist (trainers' emails)
router.get('/whitelist', async (req, res) => {
  try {
    const trainersSnapshot = await db.collection('trainers').get();
    const whitelist = [];
    
    trainersSnapshot.forEach(doc => {
      const trainer = doc.data();
      if (trainer.email) {
        whitelist.push(trainer.email.toLowerCase());
      }
    });
    
    res.json({ whitelist });
  } catch (error) {
    console.error('Error getting admin whitelist:', error);
    res.status(500).json({ error: 'Failed to get admin whitelist' });
  }
});

// Check if email is whitelisted and resolve their role.
// Precedence: a supervisor (isSupervisor on an employee record) always wins over trainer,
// since supervisor access is a superset of trainer access.
router.post('/check-whitelist', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }
    const emailLower = email.toLowerCase();

    const employeesSnapshot = await db.collection('employees')
      .where('isSupervisor', '==', true)
      .get();
    const matchedSupervisor = employeesSnapshot.docs.find(doc => (doc.data().email || '').toLowerCase() === emailLower);

    if (matchedSupervisor) {
      const doc = matchedSupervisor;
      const employee = doc.data();
      return res.json({
        isWhitelisted: true,
        role: 'supervisor',
        name: employee.name || null,
        employeeId: doc.id,
        supervisorScope: employee.supervisorScope || 'locations',
        supervisorLocations: employee.supervisorScope === 'all' ? [] : (employee.locations || []),
      });
    }

    const trainersSnapshot = await db.collection('trainers').get();
    const matchedTrainer = trainersSnapshot.docs.find(doc => (doc.data().email || '').toLowerCase() === emailLower);

    if (matchedTrainer) {
      const trainer = matchedTrainer.data();
      return res.json({
        isWhitelisted: true,
        role: 'trainer',
        name: trainer.name || null,
        trainerId: matchedTrainer.id,
        supervisorScope: null,
        supervisorLocations: [],
      });
    }

    res.json({ isWhitelisted: false, role: null });
  } catch (error) {
    console.error('Error checking whitelist:', error);
    res.status(500).json({ error: 'Failed to check whitelist' });
  }
});

export default router;

