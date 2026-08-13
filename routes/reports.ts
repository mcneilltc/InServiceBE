export {};
const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { clampSitesToScope } = require('../services/authService');
import { parseLocalDate } from '../utils/dateParsing';
import { hasCertificationOnFile } from '../utils/certificationStatus';

// Get report data with filters
router.get('/', async (req: any, res) => {
  try {
    const { name, workSite, startDate, endDate } = req.query;

    // workSite may be a single site, a comma-separated list (for a supervisor scoped to
    // multiple locations), or absent/'all' for everything.
    const clientRequestedSites: string[] | null = workSite && workSite !== 'all'
      ? String(workSite).split(',').map((s: string) => s.trim()).filter(Boolean)
      : null;
    // Clamp to the verified session's scope — never trust the client's own claim.
    const requestedSites = clampSitesToScope(req.user, clientRequestedSites);

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
      const checkin = { id: doc.id, ...doc.data() };
      
      // Filter by name if provided
      if (name && !checkin.name.toLowerCase().includes(name.toLowerCase())) {
        return;
      }

      // Filter by date range if provided. checkinTime is a full timestamp
      // (unambiguous), but startDate/endDate arrive as bare "YYYY-MM-DD"
      // strings from the date pickers — parseLocalDate keeps those boundaries
      // anchored to local midnight instead of drifting a few hours earlier.
      if (startDate || endDate) {
        const checkinDate = new Date(checkin.checkinTime);
        const startBoundary = parseLocalDate(startDate);
        const endBoundary = parseLocalDate(endDate);
        if (startBoundary && checkinDate < startBoundary) {
          return;
        }
        if (endBoundary && checkinDate > endBoundary) {
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
        workSite: (employeeData.locations && employeeData.locations.join(', ')) || 'Unknown'
      };
    }

    // Combine check-in data with employee hours
    const reportData = checkins.map(checkin => {
      // Checkins created since identity resolution was added carry a real employeeId;
      // fall back to a name match for older records that predate it.
      const employee: any = checkin.employeeId
        ? employeeHours[checkin.employeeId]
        : Object.values(employeeHours).find((emp: any) => emp.name === checkin.name);

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

// Per-employee inservice hours over a date range — the "Employee Hours"
// report type. Exempt employees are included (not hidden, unlike the
// compliance/dashboard views) since a report is for visibility, not action —
// their own row is just tagged 'exempt' rather than judged against the
// 4-hour requirement.
router.get('/hours', async (req: any, res) => {
  try {
    const { startDate, endDate, workSite } = req.query;

    const clientRequestedSites: string[] | null = workSite && workSite !== 'all'
      ? String(workSite).split(',').map((s: string) => s.trim()).filter(Boolean)
      : null;
    // homeLocation is the roster/security boundary here (mirrors dashboard
    // stats' homeSite), not the training location a checkin happened at.
    const requestedHomeSites = clampSitesToScope(req.user, clientRequestedSites);

    const dateStart = parseLocalDate(startDate) || new Date(0);
    const dateEnd = parseLocalDate(endDate) || new Date();

    const employeesSnapshot = await db.collection('employees').where('isActive', '==', true).get();
    const REQUIRED_HOURS = 4;
    const rows: any[] = [];

    for (const employeeDoc of employeesSnapshot.docs) {
      const data = employeeDoc.data();
      const location = data.homeLocation || (data.locations && data.locations[0]) || 'Unknown';
      if (requestedHomeSites && !requestedHomeSites.includes(location)) continue;

      const sessionsSnapshot = await employeeDoc.ref.collection('trainingSessions').get();
      let totalHours = 0;
      sessionsSnapshot.forEach((sessionDoc: any) => {
        const session = sessionDoc.data();
        const sessionDate = parseLocalDate(session.date);
        if (sessionDate && sessionDate >= dateStart && sessionDate <= dateEnd) {
          totalHours += parseFloat(session.length) || 0;
        }
      });
      totalHours = Math.round(totalHours * 10) / 10;

      const isExempt = !!data.isExemptFromHoursRequirement;
      const hasCert = hasCertificationOnFile(data);
      let status: string;
      if (isExempt) status = 'exempt';
      else if (!hasCert) status = 'pendingCertification';
      else if (totalHours >= REQUIRED_HOURS) status = 'complete';
      else if (totalHours >= REQUIRED_HOURS * 0.75) status = 'atRisk';
      else status = 'incomplete';

      rows.push({
        id: employeeDoc.id,
        name: data.name || 'Unknown',
        email: data.email || '',
        location,
        totalHours,
        requiredHours: REQUIRED_HOURS,
        hoursLeft: (isExempt || !hasCert) ? 0 : Math.max(0, REQUIRED_HOURS - totalHours),
        status,
        isExempt,
      });
    }

    res.json(rows);
  } catch (error) {
    console.error('Error generating hours report:', error);
    res.status(500).json({ error: { message: 'Failed to generate hours report' } });
  }
});

export default router;

