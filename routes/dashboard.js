const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

// Get training hours by location
router.get('/training-hours-by-location', async (req, res) => {
  try {
    const employeesSnapshot = await db.collection('employees').get();
    const locationHours = {};

    // Iterate through all employees
    for (const employeeDoc of employeesSnapshot.docs) {
      const sessionsSnapshot = await employeeDoc.ref.collection('trainingSessions').get();
      
      // Aggregate hours by location for each session
      sessionsSnapshot.forEach(sessionDoc => {
        const session = sessionDoc.data();
        const location = session.location || 'Unknown';
        const hours = parseFloat(session.length) || 0;
        
        locationHours[location] = (locationHours[location] || 0) + hours;
      });
    }

    res.json(locationHours);
  } catch (error) {
    console.error('Error fetching training hours by location:', error);
    res.status(500).json({ error: 'Failed to fetch training hours by location' });
  }
});

// Get employee's monthly training hours
router.get('/employee-hours/:employeeId/monthly', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { month, year } = req.query;
    
    // Default to current month and year if not provided
    const targetMonth = parseInt(month) || new Date().getMonth() + 1;
    const targetYear = parseInt(year) || new Date().getFullYear();
    
    const startDate = new Date(targetYear, targetMonth - 1, 1);
    const endDate = new Date(targetYear, targetMonth, 0);

    const sessionsSnapshot = await db
      .collection('employees')
      .doc(employeeId)
      .collection('trainingSessions')
      .where('date', '>=', startDate.toISOString().split('T')[0])
      .where('date', '<=', endDate.toISOString().split('T')[0])
      .get();

    let totalHours = 0;
    sessionsSnapshot.forEach(doc => {
      const session = doc.data();
      totalHours += parseFloat(session.length) || 0;
    });

    res.json({ totalHours });
  } catch (error) {
    console.error('Error fetching monthly training hours:', error);
    res.status(500).json({ error: 'Failed to fetch monthly training hours' });
  }
});

// Get employee's yearly training hours
router.get('/employee-hours/:employeeId/yearly', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { year } = req.query;
    
    // Default to current year if not provided
    const targetYear = parseInt(year) || new Date().getFullYear();
    
    const startDate = new Date(targetYear, 0, 1);
    const endDate = new Date(targetYear, 11, 31);

    const sessionsSnapshot = await db
      .collection('employees')
      .doc(employeeId)
      .collection('trainingSessions')
      .where('date', '>=', startDate.toISOString().split('T')[0])
      .where('date', '<=', endDate.toISOString().split('T')[0])
      .get();

    let totalHours = 0;
    sessionsSnapshot.forEach(doc => {
      const session = doc.data();
      totalHours += parseFloat(session.length) || 0;
    });

    res.json({ totalHours });
  } catch (error) {
    console.error('Error fetching yearly training hours:', error);
    res.status(500).json({ error: 'Failed to fetch yearly training hours' });
  }
});

module.exports = router; 