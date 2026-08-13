export {};
const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { clampSitesToScope } = require('../services/authService');
import { parseLocalDate } from '../utils/dateParsing';
import { hasCertificationOnFile } from '../utils/certificationStatus';

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
    const { workSite, homeSite, period, startDate, endDate } = req.query;

    // workSite narrows by TRAINING location (where a session/check-in
    // physically happened) — a display filter, not a security boundary. A
    // supervisor scoped to ERRC still needs to be able to filter by e.g. MCAC
    // to see where their own ERRC-homebased staff went to train — so this is
    // deliberately NOT clamped to the caller's own scope.
    const requestedSites: string[] | null = workSite && workSite !== 'all'
      ? String(workSite).split(',').map((s) => s.trim()).filter(Boolean)
      : null;

    // homeSite narrows the roster itself by employees' HOME location — this
    // is the real security boundary, so it IS clamped to the caller's scope.
    // With no homeSite given, a location-scoped supervisor still gets
    // clamped to their own site(s) by default (clampSitesToScope returns
    // their full allowed list rather than null in that case).
    const clientRequestedHomeSites: string[] | null = homeSite
      ? String(homeSite).split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    const requestedHomeSites = clampSitesToScope(req.user, clientRequestedHomeSites);

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
      dateStart = parseLocalDate(startDate as string) || new Date(0);
      dateEnd = parseLocalDate(endDate as string) || new Date();
    } else {
      // Default to all time
      dateStart = new Date(0);
      dateEnd = new Date();
    }

    // Employees + their home locations first — the roster and check-in
    // scoping below both depend on this.
    const allEmployeesSnapshot = await db.collection('employees').get();
    const allEmployees: any[] = [];

    for (const employeeDoc of allEmployeesSnapshot.docs) {
      const employeeData = employeeDoc.data();
      // Some supervisors are exempt from the 4-hour inservice requirement —
      // leave them off the roster this endpoint tracks entirely.
      if (employeeData.isExemptFromHoursRequirement) continue;
      // A newly added/imported employee with no certification on file yet
      // isn't tracked for compliance until one is added.
      if (!hasCertificationOnFile(employeeData)) continue;

      // Calculate total hours from training sessions (length is stored in hours,
      // consistent with reports.ts, employeeSelfServiceController, and the session close-out pipeline).
      // Only sessions at the filtered training location count, if one is given.
      const sessionsSnapshot = await employeeDoc.ref.collection('trainingSessions').get();
      let totalHours = 0;
      sessionsSnapshot.forEach((sessionDoc: any) => {
        const session = sessionDoc.data();
        const sessionDate = parseLocalDate(session.date);
        if (sessionDate && sessionDate >= dateStart && sessionDate <= dateEnd) {
          if (!requestedSites || requestedSites.includes(session.location)) {
            totalHours += parseFloat(session.length) || 0;
          }
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

    // Roster scoping — always by home location, this is the security boundary.
    let filteredEmployees = allEmployees;
    if (requestedHomeSites) {
      filteredEmployees = allEmployees.filter((emp: any) => requestedHomeSites.includes(emp.homeLocation));
    }
    const inScopeEmployeeIds = new Set(filteredEmployees.map((e: any) => e.id));

    // Check-ins: scoped to the (home-scoped) roster first, then narrowed by
    // training location if requested. "All sites" for a scoped supervisor
    // still means all of *their* people's check-ins, never company-wide.
    const checkinsSnapshot = await db.collection('checkins').get();
    const homeScopedCheckins: any[] = [];
    checkinsSnapshot.forEach((doc: any) => {
      const checkin = doc.data();
      const checkinDate = new Date(checkin.checkinTime);
      if (checkinDate < dateStart || checkinDate > dateEnd) return;
      if (requestedHomeSites && !inScopeEmployeeIds.has(checkin.employeeId)) return;
      homeScopedCheckins.push({ id: doc.id, ...checkin });
    });
    const checkins = requestedSites
      ? homeScopedCheckins.filter((c) => requestedSites.includes(c.location))
      : homeScopedCheckins;
    const allCheckins = homeScopedCheckins;

    // Get all sessions (not roster-scoped — a session isn't "owned" by one
    // supervisor's staff — just narrowed by training location if requested).
    const sessionsSnapshot = await db.collection('sessions').get();
    const sessions: any[] = [];
    sessionsSnapshot.forEach((doc: any) => {
      const session = doc.data();
      const sessionDate = parseLocalDate(session.date);
      if (sessionDate && sessionDate >= dateStart && sessionDate <= dateEnd) {
        if (!requestedSites || requestedSites.includes(session.location)) {
          sessions.push({ id: doc.id, ...session });
        }
      }
    });

    // Calculate statistics
    const uniqueEmployees = new Set(checkins.map((c) => c.employeeId || c.email || c.name));
    const completions = checkins.length;
    const totalSessions = sessions.length;

    // Show all employees with their training status
    // Status calculation: complete (>=100%), atRisk (75-99%), incomplete (<75%)
    const employeesNeedingTraining = filteredEmployees.map(emp => {
      const hasCheckedIn = checkins.some(c => c.employeeId === emp.id);
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
        location: emp.homeLocation || 'Unknown',
        totalHours: emp.totalHours || 0,
        requiredHours: emp.requiredHours || 4,
        hoursLeft: emp.hoursLeft || 0,
        status: emp.status
      })),
      trainingCompleted: checkins.length,
      trainingCompletedAllSites: allCheckins.length,
      totalSessions,
      uniqueEmployees: uniqueEmployees.size,
      period: period || 'custom',
      workSite: workSite || 'all',
      homeSite: homeSite || 'all'
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard statistics' });
  }
});

export default router; 