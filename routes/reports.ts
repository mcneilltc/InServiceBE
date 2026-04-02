export {};
const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

// Get report data with filters
router.get('/', async (req, res) => {
  try {
    const { name, workSite, startDate, endDate } = req.query;

    // Get all check-ins
    let checkinsQuery = db.collection('checkins');

    // Apply filters
    if (workSite) {
      checkinsQuery = checkinsQuery.where('location', '==', workSite);
    }

    const checkinsSnapshot = await checkinsQuery.get();
    const checkins = [];

    checkinsSnapshot.forEach(doc => {
      const checkin = { id: doc.id, ...doc.data() };
      
      // Filter by name if provided
      if (name && !checkin.name.toLowerCase().includes(name.toLowerCase())) {
        return;
      }

      // Filter by date range if provided
      if (startDate || endDate) {
        const checkinDate = new Date(checkin.checkinTime);
        if (startDate && checkinDate < new Date(startDate)) {
          return;
        }
        if (endDate && checkinDate > new Date(endDate)) {
          return;
        }
      }

      checkins.push(checkin);
    });

    // Get training hours for each employee
    const employeesSnapshot = await db.collection('employees').get();
    const employeeHours: Record<string, any> = {};

    for (const employeeDoc of employeesSnapshot.docs) {
      const employeeData = employeeDoc.data();
      const sessionsSnapshot = await employeeDoc.ref.collection('trainingSessions').get();
      
      let totalHours = 0;
      sessionsSnapshot.forEach(sessionDoc => {
        const session = sessionDoc.data();
        totalHours += parseFloat(session.length) || 0;
      });

      employeeHours[employeeDoc.id] = {
        name: employeeData.name,
        totalHours: totalHours,
        workSite: employeeData.location || 'Unknown'
      };
    }

    // Combine check-in data with employee hours
    const reportData = checkins.map(checkin => {
      // Try to find matching employee by email or name
      const employee: any = Object.values(employeeHours).find(
        (emp: any) => emp.name === checkin.name || checkin.email
      );

      return {
        name: checkin.name,
        email: checkin.email,
        phone: checkin.phone,
        workSite: checkin.location,
        checkinTime: checkin.checkinTime,
        trainingHoursCompleted: employee?.totalHours || 0
      };
    });

    res.json(reportData);
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

export default router;

