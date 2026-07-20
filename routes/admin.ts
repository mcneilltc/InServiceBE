export {};
const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { requireRole } = require('../middleware/requireRole');

// Get admin whitelist (trainers' emails) — supervisor-only; no reason this
// should be publicly readable now that we can actually enforce that.
router.get('/whitelist', requireRole(['supervisor']), async (req, res) => {
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

export default router;
