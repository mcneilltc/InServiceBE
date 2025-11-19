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

// Check if email is whitelisted
router.post('/check-whitelist', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }
    
    const trainersSnapshot = await db.collection('trainers').get();
    const whitelist = [];
    
    trainersSnapshot.forEach(doc => {
      const trainer = doc.data();
      if (trainer.email) {
        whitelist.push(trainer.email.toLowerCase());
      }
    });
    
    const isWhitelisted = whitelist.includes(email.toLowerCase());
    
    res.json({ isWhitelisted });
  } catch (error) {
    console.error('Error checking whitelist:', error);
    res.status(500).json({ error: 'Failed to check whitelist' });
  }
});

module.exports = router;

