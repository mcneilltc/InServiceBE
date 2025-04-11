const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

// Get all trainers
router.get('/', async (req, res) => {
  try {
    const trainersSnapshot = await db.collection('trainers').get();
    const trainers = [];
    trainersSnapshot.forEach(doc => {
      trainers.push({ id: doc.id, ...doc.data() });
    });
    res.json(trainers);
  } catch (error) {
    console.error('Error getting trainers:', error);
    res.status(500).json({ error: 'Failed to get trainers' });
  }
});

// Get a single trainer by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.collection('trainers').doc(id).get();
    
    if (!doc.exists) {
      return res.status(404).json({ message: 'Trainer not found' });
    }
    
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    console.error('Error getting trainer:', error);
    res.status(500).json({ error: 'Failed to get trainer' });
  }
});

// Create a new trainer
router.post('/', async (req, res) => {
  try {
    const { trainerName } = req.body;
    if (!trainerName) {
      return res.status(400).json({ message: 'Trainer name is required' });
    }

    const trainerData = {
      name: trainerName,
      createdAt: new Date().toISOString()
    };

    const docRef = await db.collection('trainers').add(trainerData);
    res.status(201).json({ 
      message: 'Trainer added', 
      id: docRef.id, 
      trainer: { id: docRef.id, ...trainerData }
    });
  } catch (error) {
    console.error('Error adding trainer:', error);
    res.status(500).json({ error: 'Failed to add trainer' });
  }
});

// Update a trainer
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { trainerName } = req.body;

    const docRef = db.collection('trainers').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Trainer not found' });
    }

    const updateData = {
      name: trainerName,
      updatedAt: new Date().toISOString()
    };

    await docRef.update(updateData);
    res.json({ 
      message: 'Trainer updated', 
      id, 
      trainer: { id, ...doc.data(), ...updateData }
    });
  } catch (error) {
    console.error('Error updating trainer:', error);
    res.status(500).json({ error: 'Failed to update trainer' });
  }
});

// Delete a trainer
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection('trainers').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Trainer not found' });
    }

    // Check if trainer is assigned to any sessions
    const employeesSnapshot = await db.collection('employees').get();
    let hasSessions = false;

    for (const employeeDoc of employeesSnapshot.docs) {
      const sessionsSnapshot = await employeeDoc.ref
        .collection('trainingSessions')
        .where('trainer', '==', id)
        .get();

      if (!sessionsSnapshot.empty) {
        hasSessions = true;
        break;
      }
    }

    if (hasSessions) {
      return res.status(400).json({ 
        message: 'Cannot delete trainer. Trainer is assigned to existing training sessions.' 
      });
    }

    await docRef.delete();
    res.json({ message: 'Trainer deleted' });
  } catch (error) {
    console.error('Error deleting trainer:', error);
    res.status(500).json({ error: 'Failed to delete trainer' });
  }
});

module.exports = router; 