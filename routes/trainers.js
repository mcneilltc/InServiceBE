const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

// Get all trainers (optionally include archived)
router.get('/', async (req, res) => {
  try {
    const includeArchived = req.query.archived === 'true';
    let trainersRef = db.collection('trainers');
    if (!includeArchived) {
      trainersRef = trainersRef.where('archived', '==', false);
    }
    const trainersSnapshot = await trainersRef.get();
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
    const { name, email, phone } = req.body; // Extract email and phone

    if (!name || !email) {
      return res.status(400).json({ message: 'Trainer name and email are required' });
    }

    const trainerData = {
      name: name.trim(),
      email: email.trim(),
      phone: phone?.trim() || '',
      archived: false, // Default to false when creating
      createdAt: new Date().toISOString(),
    };

    const docRef = await db.collection('trainers').add(trainerData);
    res.status(201).json({
      message: 'Trainer added',
      id: docRef.id,
      trainer: { id: docRef.id, ...trainerData }
      
    });
    console.log('Added trainer:', { id: docRef.id, ...trainerData });

  } catch (error) {
    console.error('Error adding trainer:', error);
    res.status(500).json({ error: 'Failed to add trainer' });
  }
});

// Update a trainer
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, archived } = req.body; // Include archived in the update

    const docRef = db.collection('trainers').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Trainer not found' });
    }

    const updateData = {
      ...(name && { name: name.trim() }),
      ...(email && { email: email.trim() }),
      ...(phone && { phone: phone?.trim() }),
      ...(typeof archived === 'boolean' && { archived }), // Only update if archived is explicitly provided
      updatedAt: new Date().toISOString()
    };

    await docRef.update(updateData);
    const updatedDoc = await db.collection('trainers').doc(id).get();

    // Set cache control headers
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache'); // For older browsers
    res.setHeader('Expires', '0');

    res.json({
      message: 'Trainer updated',
      id,
      trainer: { id: updatedDoc.id, ...updatedDoc.data() }
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

// // Archive a trainer
// router.put('/:id/archive', async (req, res) => {
//   try {
//     const { id } = req.params;
//     const docRef = db.collection('trainers').doc(id);
//     const doc = await docRef.get();

//     if (!doc.exists) {
//       return res.status(404).json({ message: 'Trainer not found' });
//     }

//     await docRef.update({ archived: true });
//     res.json({ message: 'Trainer archived' });
//   } catch (error) {
//     console.error('Error archiving trainer:', error);
//     res.status(500).json({ error: 'Failed to archive trainer' });
//   }
// });

// // Unarchive a trainer
// router.put('/:id/unarchive', async (req, res) => {
//   try {
//     const { id } = req.params;
//     const docRef = db.collection('trainers').doc(id);
//     const doc = await docRef.get();

//     if (!doc.exists) {
//       return res.status(404).json({ message: 'Trainer not found' });
//     }

//     await docRef.update({ archived: false });
//     res.json({ message: 'Trainer unarchived' });
//   } catch (error) {
//     console.error('Error unarchiving trainer:', error);
//     res.status(500).json({ error: 'Failed to unarchive trainer' });
//   }
// });

// // Get archived trainers
// router.get('/', async (req, res) => {
//   try {
//     const { archived } = req.query; // Extract 'archived' query parameter
//     let trainersRef = db.collection('trainers');

//     // Filter trainers based on the 'archived' query parameter
//     if (archived !== undefined) {
//       const isArchived = archived === 'true'; // Convert string to boolean
//       trainersRef = trainersRef.where('archived', '==', isArchived);
//     }

//     const trainersSnapshot = await trainersRef.get();
//     const trainers = [];
//     trainersSnapshot.forEach(doc => {
//       trainers.push({ id: doc.id, ...doc.data() });
//     });

//     res.status(200).json(trainers);
//   } catch (error) {
//     console.error('Error getting trainers:', error);
//     res.status(500).json({ error: 'Failed to get trainers' });
//   }
// });

module.exports = router;