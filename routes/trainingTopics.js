const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

// Get all training topics
router.get('/', async (req, res) => {
  try {
    const topicsSnapshot = await db.collection('trainingTopics').get();
    const topics = [];
    topicsSnapshot.forEach(doc => {
      topics.push({ id: doc.id, ...doc.data() });
    });
    res.json(topics);
  } catch (error) {
    console.error('Error getting training topics:', error);
    res.status(500).json({ error: 'Failed to get training topics' });
  }
});

// Get a single training topic by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.collection('trainingTopics').doc(id).get();
    
    if (!doc.exists) {
      return res.status(404).json({ message: 'Training topic not found' });
    }
    
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    console.error('Error getting training topic:', error);
    res.status(500).json({ error: 'Failed to get training topic' });
  }
});

// Create a new training topic
router.post('/', async (req, res) => {
  try {
    const { topicName } = req.body;
    if (!topicName) {
      return res.status(400).json({ message: 'Topic name is required' });
    }

    const topicData = {
      name: topicName,
      createdAt: new Date().toISOString()
    };

    const docRef = await db.collection('trainingTopics').add(topicData);
    res.status(201).json({ 
      message: 'Training topic added', 
      id: docRef.id, 
      topic: { id: docRef.id, ...topicData }
    });
  } catch (error) {
    console.error('Error adding training topic:', error);
    res.status(500).json({ error: 'Failed to add training topic' });
  }
});

// Update a training topic
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { topicName } = req.body;

    const docRef = db.collection('trainingTopics').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Training topic not found' });
    }

    const updateData = {
      name: topicName,
      updatedAt: new Date().toISOString()
    };

    await docRef.update(updateData);
    res.json({ 
      message: 'Training topic updated', 
      id, 
      topic: { id, ...doc.data(), ...updateData }
    });
  } catch (error) {
    console.error('Error updating training topic:', error);
    res.status(500).json({ error: 'Failed to update training topic' });
  }
});

// Delete a training topic
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection('trainingTopics').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Training topic not found' });
    }

    // Check if topic is used in any sessions
    const employeesSnapshot = await db.collection('employees').get();
    let hasSessions = false;

    for (const employeeDoc of employeesSnapshot.docs) {
      const sessionsSnapshot = await employeeDoc.ref
        .collection('trainingSessions')
        .where('topic', '==', id)
        .get();

      if (!sessionsSnapshot.empty) {
        hasSessions = true;
        break;
      }
    }

    if (hasSessions) {
      return res.status(400).json({ 
        message: 'Cannot delete topic. Topic is used in existing training sessions.' 
      });
    }

    await docRef.delete();
    res.json({ message: 'Training topic deleted' });
  } catch (error) {
    console.error('Error deleting training topic:', error);
    res.status(500).json({ error: 'Failed to delete training topic' });
  }
});

module.exports = router; 