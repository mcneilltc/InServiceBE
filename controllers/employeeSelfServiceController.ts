import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';
import moment from 'moment';

const MIDMONTH_THRESHOLD = 2;
const MONTHLY_THRESHOLD = 4;

// POST /api/employee/lookup
// Body: { firstName, lastName, badgeNumber }
export const lookupEmployee = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { firstName, lastName, badgeNumber } = req.body;

    if (!badgeNumber || !firstName || !lastName) {
      return res.status(400).json({ error: { message: 'Badge number, first name and last name are required.' } });
    }

    const badgeTrimmed = String(badgeNumber).trim();

    // Search by badgeNumber — most selective filter first
    const snapshot = await db.collection('employees').where('badgeNumber', '==', badgeTrimmed).get();

    if (snapshot.empty) {
      return res.status(404).json({ error: { message: 'No employee found with that badge number. Please check your information.' } });
    }

    // Determine which doc matches by first/last name
    let matchedDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    const firstNameLower = String(firstName).trim().toLowerCase();
    const lastNameLower = String(lastName).trim().toLowerCase();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const storedFirst = (data.firstName || '').toLowerCase();
      const storedLast = (data.lastName || '').toLowerCase();
      const [legacyFirst = '', ...legacyLastParts] = (data.name || '').toLowerCase().split(' ');
      const legacyLast = legacyLastParts.join(' ');
      const firstMatch = storedFirst === firstNameLower || legacyFirst === firstNameLower;
      const lastMatch = storedLast === lastNameLower || legacyLast === lastNameLower;
      if (firstMatch && lastMatch) {
        matchedDoc = doc;
        break;
      }
    }

    if (!matchedDoc) {
      return res.status(404).json({ error: { message: 'Name does not match our records for that badge number. Please check your information.' } });
    }

    const employeeId = matchedDoc.id;
    const employeeData = matchedDoc.data();

    // Fetch this month's training sessions
    const monthStart = moment().startOf('month').toDate();
    const monthEnd   = moment().endOf('month').toDate();

    const sessionsSnap = await db
      .collection('employees')
      .doc(employeeId)
      .collection('trainingSessions')
      .get();

    const thisMonthSessions: any[] = [];
    let totalHoursThisMonth = 0;

    sessionsSnap.forEach((doc: any) => {
      const s = doc.data();
      const sessionDate = s.date ? new Date(s.date) : null;
      if (sessionDate && sessionDate >= monthStart && sessionDate <= monthEnd) {
        const hrs = parseFloat(s.length) || 0;
        totalHoursThisMonth += hrs;
        thisMonthSessions.push({
          id: doc.id,
          topic: s.topic,
          trainer: s.trainer,
          date: s.date,
          hours: hrs,
          location: s.location,
        });
      }
    });

    totalHoursThisMonth = Math.round(totalHoursThisMonth * 10) / 10;

    // Sort sessions newest first
    thisMonthSessions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const today = moment().date();
    const isMidMonthPassed = today >= 15;
    const midMonthCompliant  = totalHoursThisMonth >= MIDMONTH_THRESHOLD;
    const monthlyCompliant   = totalHoursThisMonth >= MONTHLY_THRESHOLD;

    let complianceStatus: 'compliant' | 'at_risk' | 'non_compliant';
    let complianceMessage: string;
    let hoursRemaining: number;

    if (monthlyCompliant) {
      complianceStatus  = 'compliant';
      hoursRemaining    = 0;
      complianceMessage = `Great work! You have met the ${MONTHLY_THRESHOLD}-hour monthly requirement.`;
    } else if (isMidMonthPassed && !midMonthCompliant) {
      complianceStatus  = 'non_compliant';
      hoursRemaining    = MONTHLY_THRESHOLD - totalHoursThisMonth;
      complianceMessage = `You have ${totalHoursThisMonth} hour(s) recorded. You needed ${MIDMONTH_THRESHOLD} hours by the 15th and need ${MONTHLY_THRESHOLD} total by month end. ${hoursRemaining.toFixed(1)} hour(s) remaining.`;
    } else {
      complianceStatus  = 'at_risk';
      hoursRemaining    = MONTHLY_THRESHOLD - totalHoursThisMonth;
      complianceMessage = `You have ${totalHoursThisMonth} hour(s) recorded this month. ${hoursRemaining.toFixed(1)} more hour(s) needed by month end.`;
    }

    res.json({
      employee: {
        id: employeeId,
        firstName: employeeData.firstName || employeeData.name?.split(' ')[0] || firstName,
        lastName:  employeeData.lastName  || employeeData.name?.split(' ').slice(1).join(' ') || lastName,
        badgeNumber: employeeData.badgeNumber,
        location: (employeeData.locations && employeeData.locations[0]) || employeeData.location || '',
        depth: employeeData.depth || null,
        certificationExpiration: employeeData.certificationExpiration || null,
        hasSlideCert: employeeData.hasSlideCert || false,
        hasSwimCert:  employeeData.hasSwimCert  || false,
        isEliteSupervisor: employeeData.isEliteSupervisor || false,
      },
      compliance: {
        status: complianceStatus,
        message: complianceMessage,
        hoursThisMonth: totalHoursThisMonth,
        hoursRemaining,
        midMonthCompliant,
        monthlyCompliant,
        month: moment().format('MMMM YYYY'),
        thresholds: { midMonth: MIDMONTH_THRESHOLD, endOfMonth: MONTHLY_THRESHOLD },
      },
      sessions: thisMonthSessions,
    });
  } catch (error) {
    next(error);
  }
};
