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

    const rawSessions: { id: string; data: FirebaseFirestore.DocumentData }[] = [];
    const trainerIdsToResolve = new Set<string>();

    sessionsSnap.forEach((doc: any) => {
      const s = doc.data();
      const sessionDate = s.date ? new Date(s.date) : null;
      if (sessionDate && sessionDate >= monthStart && sessionDate <= monthEnd) {
        rawSessions.push({ id: doc.id, data: s });
        const trainerValues: string[] = Array.isArray(s.trainer) ? s.trainer : (s.trainer ? [s.trainer] : []);
        trainerValues.forEach((t) => trainerIdsToResolve.add(t));
      }
    });

    // Historical sessions stored `trainer` as a raw employee ID, an array of employee
    // IDs, or (pre-dating the trainer-consistency fix) an already-resolved name string.
    // Resolve every distinct value against the employees collection and fall back to the
    // original value when it isn't a known employee ID, since it's then already a name.
    const trainerNameMap = new Map<string, string>();
    await Promise.all(
      Array.from(trainerIdsToResolve).map(async (trainerId) => {
        try {
          const trainerDoc = await db.collection('employees').doc(trainerId).get();
          if (trainerDoc.exists) {
            const trainerData = trainerDoc.data() as any;
            const displayName = trainerData.name || `${trainerData.firstName || ''} ${trainerData.lastName || ''}`.trim();
            if (displayName) {
              trainerNameMap.set(trainerId, displayName);
            }
          }
        } catch {
          // Not a resolvable document ID (e.g. malformed legacy value) — leave unresolved.
        }
      })
    );

    const resolveTrainerDisplay = (trainerField: any): string => {
      const values: string[] = Array.isArray(trainerField) ? trainerField : (trainerField ? [trainerField] : []);
      return values.map((v) => trainerNameMap.get(v) || v).join(', ');
    };

    let totalHoursThisMonth = 0;
    const thisMonthSessions: any[] = rawSessions.map(({ id, data: s }) => {
      const hrs = parseFloat(s.length) || 0;
      totalHoursThisMonth += hrs;
      return {
        id,
        topics: s.topics || (s.topic ? [s.topic] : []),
        trainer: resolveTrainerDisplay(s.trainer),
        date: s.date,
        hours: hrs,
        location: s.location,
      };
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
        location: employeeData.homeLocation || (employeeData.locations && employeeData.locations[0]) || employeeData.location || '',
        certifications: Array.isArray(employeeData.certifications) ? employeeData.certifications : [],
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
