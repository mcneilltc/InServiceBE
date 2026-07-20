export {};
const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { clampSitesToScope } = require('../services/authService');

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

// Get dashboard statistics with filters
router.get('/stats', async (req: any, res) => {
  try {
    const { workSite, period, startDate, endDate } = req.query;

    // workSite may be a single site, a comma-separated list of sites (for a
    // supervisor scoped to multiple locations), or absent/'all' for everything.
    const clientRequestedSites: string[] | null = workSite && workSite !== 'all'
      ? String(workSite).split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    // Clamp to the verified session's scope — never trust the client's own claim.
    const requestedSites = clampSitesToScope(req.user, clientRequestedSites);

    // Calculate date range based on period
    let dateStart, dateEnd;
    const now = new Date();
    
    if (period === 'day') {
      dateStart = new Date(now.setHours(0, 0, 0, 0));
      dateEnd = new Date(now.setHours(23, 59, 59, 999));
    } else if (period === 'week') {
      const dayOfWeek = now.getDay();
      dateStart = new Date(now);
      dateStart.setDate(now.getDate() - dayOfWeek);
      dateStart.setHours(0, 0, 0, 0);
      dateEnd = new Date(dateStart);
      dateEnd.setDate(dateStart.getDate() + 6);
      dateEnd.setHours(23, 59, 59, 999);
    } else if (period === 'month') {
      dateStart = new Date(now.getFullYear(), now.getMonth(), 1);
      dateEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (period === 'year') {
      dateStart = new Date(now.getFullYear(), 0, 1);
      dateEnd = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
    } else if (startDate && endDate) {
      dateStart = new Date(startDate);
      dateEnd = new Date(endDate);
    } else {
      // Default to all time
      dateStart = new Date(0);
      dateEnd = new Date();
    }

    // Get all check-ins.
    // requestedSites === [] means the clamp reduced a scoped supervisor's
    // request to nothing they're allowed to see — that must return no rows,
    // not fall through to "no filter" the way a naive length check would.
    let checkinsQuery = db.collection('checkins');
    if (requestedSites) {
      if (requestedSites.length === 0) {
        checkinsQuery = checkinsQuery.where('location', '==', '__no_access__');
      } else if (requestedSites.length === 1) {
        checkinsQuery = checkinsQuery.where('location', '==', requestedSites[0]);
      } else {
        checkinsQuery = checkinsQuery.where('location', 'in', requestedSites);
      }
    }

    const checkinsSnapshot = await checkinsQuery.get();
    const checkins = [];
    
    checkinsSnapshot.forEach(doc => {
      const checkin = doc.data();
      const checkinDate = new Date(checkin.checkinTime);
      if (checkinDate >= dateStart && checkinDate <= dateEnd) {
        checkins.push({ id: doc.id, ...checkin });
      }
    });

    // Get all sessions
    const sessionsSnapshot = await db.collection('sessions').get();
    const sessions = [];
    
    sessionsSnapshot.forEach(doc => {
      const session = doc.data();
      const sessionDate = new Date(session.date);
      if (sessionDate >= dateStart && sessionDate <= dateEnd) {
        if (!requestedSites || requestedSites.includes(session.location)) {
          sessions.push({ id: doc.id, ...session });
        }
      }
    });

    // Calculate statistics
    const uniqueEmployees = new Set(checkins.map(c => c.email || c.name));
    const completions = checkins.length;
    const totalSessions = sessions.length;
    
    // Get employees who need to complete training with hours information
    const allEmployeesSnapshot = await db.collection('employees').get();
    const allEmployees = [];
    
    for (const employeeDoc of allEmployeesSnapshot.docs) {
      const employeeData = employeeDoc.data();
      
      // Calculate total hours from training sessions (length is stored in hours,
      // consistent with reports.ts, employeeSelfServiceController, and the session close-out pipeline)
      const sessionsSnapshot = await employeeDoc.ref.collection('trainingSessions').get();
      let totalHours = 0;
      sessionsSnapshot.forEach(sessionDoc => {
        const session = sessionDoc.data();
        const sessionDate = new Date(session.date);
        if (sessionDate >= dateStart && sessionDate <= dateEnd) {
          totalHours += parseFloat(session.length) || 0;
        }
      });

      const requiredHours = 4;
      const hoursLeft = Math.max(0, requiredHours - totalHours);
      
      allEmployees.push({ 
        id: employeeDoc.id, 
        ...employeeData,
        totalHours,
        requiredHours,
        hoursLeft
      });
    }

    // Filter by workSite if specified — employees store their site(s) in `locations` (array)
    let filteredEmployees = allEmployees;
    if (requestedSites) {
      filteredEmployees = allEmployees.filter((emp: any) =>
        (emp.locations || []).some((loc: string) => requestedSites.includes(loc))
      );
    }

    // Show all employees with their training status
    // Status calculation: complete (>=100%), atRisk (75-99%), incomplete (<75%)
    const employeesNeedingTraining = filteredEmployees.map(emp => {
      const hasCheckedIn = checkins.some(c => 
        c.email === emp.email || c.name === emp.name
      );
      const hasCompletedHours = emp.totalHours >= emp.requiredHours;
      
      // Determine status based on hours completed
      let status = 'incomplete';
      if (emp.totalHours >= emp.requiredHours) {
        status = 'complete';
      } else if (emp.totalHours >= emp.requiredHours * 0.75) {
        status = 'atRisk';
      }
      
      return {
        ...emp,
        hasCheckedIn,
        hasCompletedHours,
        status
      };
    });

    // Calculate training completed for all sites combined
    const allCheckinsSnapshot = await db.collection('checkins').get();
    const allCheckins = [];
    allCheckinsSnapshot.forEach(doc => {
      const checkin = doc.data();
      const checkinDate = new Date(checkin.checkinTime);
      if (checkinDate >= dateStart && checkinDate <= dateEnd) {
        allCheckins.push({ id: doc.id, ...checkin });
      }
    });

    // Calculate training completed based on filters
    let trainingCompleted = allCheckins.length;
    if (workSite && workSite !== 'all') {
      trainingCompleted = checkins.length; // Already filtered by workSite
    }

    // Count employees who actually need training (not complete)
    const needToCompleteCount = employeesNeedingTraining.filter(emp => 
      emp.status !== 'complete'
    ).length;

    res.json({
      completions,
      needToComplete: needToCompleteCount,
      employeesNeedingTraining: employeesNeedingTraining.map(emp => ({
        id: emp.id,
        name: emp.name,
        email: emp.email,
        location: (emp.locations && emp.locations.join(', ')) || 'Unknown',
        totalHours: emp.totalHours || 0,
        requiredHours: emp.requiredHours || 4,
        hoursLeft: emp.hoursLeft || 0,
        status: emp.status
      })),
      trainingCompleted: trainingCompleted,
      trainingCompletedAllSites: allCheckins.length,
      totalSessions,
      uniqueEmployees: uniqueEmployees.size,
      period: period || 'custom',
      workSite: workSite || 'all'
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard statistics' });
  }
});

export default router; 