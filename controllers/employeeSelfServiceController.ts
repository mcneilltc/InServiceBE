import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';
import moment from 'moment';
import { getEmployeeIncentiveSummary, SessionRecord } from '../services/incentiveService';

const MIDMONTH_THRESHOLD = 2;
const MONTHLY_THRESHOLD = 4;

// Historical sessions stored `trainer` as a raw employee ID, an array of employee
// IDs, or (pre-dating the trainer-consistency fix) an already-resolved name string.
// Resolves every distinct value against the employees collection, falling back to the
// original value when it isn't a known employee ID, since it's then already a name.
// Shared by the self-service lookup and the manager-facing employee detail endpoint so
// the two never drift on trainer-name-resolution behavior.
async function resolveSessionsWithTrainerNames(
  rawSessions: { id: string; data: FirebaseFirestore.DocumentData }[]
): Promise<{ sessions: any[]; totalHoursThisMonth: number }> {
  const trainerIdsToResolve = new Set<string>();
  rawSessions.forEach(({ data: s }) => {
    const trainerValues: string[] = Array.isArray(s.trainer) ? s.trainer : (s.trainer ? [s.trainer] : []);
    trainerValues.forEach((t) => trainerIdsToResolve.add(t));
  });

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
  const sessions: any[] = rawSessions.map(({ id, data: s }) => {
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
  sessions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return { sessions, totalHoursThisMonth };
}

// Shared compliance computation for one employee's this-month hours, used by both the
// self-service lookup and the manager-facing employee detail endpoint.
function computeCompliance(totalHoursThisMonth: number) {
  const today = moment().date();
  const isMidMonthPassed = today >= 15;
  const midMonthCompliant = totalHoursThisMonth >= MIDMONTH_THRESHOLD;
  const monthlyCompliant = totalHoursThisMonth >= MONTHLY_THRESHOLD;

  let status: 'compliant' | 'at_risk' | 'non_compliant';
  let message: string;
  let hoursRemaining: number;

  if (monthlyCompliant) {
    status = 'compliant';
    hoursRemaining = 0;
    message = `Great work! You have met the ${MONTHLY_THRESHOLD}-hour monthly requirement.`;
  } else if (isMidMonthPassed && !midMonthCompliant) {
    status = 'non_compliant';
    hoursRemaining = MONTHLY_THRESHOLD - totalHoursThisMonth;
    message = `You have ${totalHoursThisMonth} hour(s) recorded. You needed ${MIDMONTH_THRESHOLD} hours by the 15th and need ${MONTHLY_THRESHOLD} total by month end. ${hoursRemaining.toFixed(1)} hour(s) remaining.`;
  } else {
    status = 'at_risk';
    hoursRemaining = MONTHLY_THRESHOLD - totalHoursThisMonth;
    message = `You have ${totalHoursThisMonth} hour(s) recorded this month. ${hoursRemaining.toFixed(1)} more hour(s) needed by month end.`;
  }

  return {
    status,
    message,
    hoursThisMonth: totalHoursThisMonth,
    hoursRemaining,
    midMonthCompliant,
    monthlyCompliant,
    month: moment().format('MMMM YYYY'),
    thresholds: { midMonth: MIDMONTH_THRESHOLD, endOfMonth: MONTHLY_THRESHOLD },
  };
}

function shapeEmployeeForResponse(employeeId: string, employeeData: FirebaseFirestore.DocumentData, fallbackFirst?: string, fallbackLast?: string) {
  return {
    id: employeeId,
    firstName: employeeData.firstName || employeeData.name?.split(' ')[0] || fallbackFirst || '',
    lastName: employeeData.lastName || employeeData.name?.split(' ').slice(1).join(' ') || fallbackLast || '',
    badgeNumber: employeeData.badgeNumber,
    location: employeeData.homeLocation || (employeeData.locations && employeeData.locations[0]) || employeeData.location || '',
    certifications: Array.isArray(employeeData.certifications) ? employeeData.certifications : [],
    depth: employeeData.depth || null,
    certificationExpiration: employeeData.certificationExpiration || null,
    hasSlideCert: employeeData.hasSlideCert || false,
    hasSwimCert: employeeData.hasSwimCert || false,
    isEliteSupervisor: employeeData.isEliteSupervisor || false,
  };
}

type RawSession = { id: string; data: FirebaseFirestore.DocumentData };

// Reads an employee's entire trainingSessions subcollection exactly once.
// Both the "this month" session list (for the compliance card) and the
// SessionRecord[] the incentive summary needs are derived from this same
// in-memory result below, instead of each doing their own separate read of
// the identical subcollection.
async function getAllRawSessions(employeeId: string): Promise<RawSession[]> {
  const sessionsSnap = await db
    .collection('employees')
    .doc(employeeId)
    .collection('trainingSessions')
    .get();

  const rawSessions: RawSession[] = [];
  sessionsSnap.forEach((doc: any) => {
    rawSessions.push({ id: doc.id, data: doc.data() });
  });
  return rawSessions;
}

function filterToThisMonth(rawSessions: RawSession[]): RawSession[] {
  const monthStart = moment().startOf('month').toDate();
  const monthEnd = moment().endOf('month').toDate();
  return rawSessions.filter(({ data: s }) => {
    const sessionDate = s.date ? new Date(s.date) : null;
    return !!sessionDate && sessionDate >= monthStart && sessionDate <= monthEnd;
  });
}

function toSessionRecords(rawSessions: RawSession[]): SessionRecord[] {
  const records: SessionRecord[] = [];
  for (const { data: s } of rawSessions) {
    const date = s.date ? new Date(s.date) : null;
    if (date && !isNaN(date.getTime())) {
      records.push({ date, length: parseFloat(s.length) || 0 });
    }
  }
  return records;
}

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

    const allRawSessions = await getAllRawSessions(employeeId);
    const { sessions, totalHoursThisMonth } = await resolveSessionsWithTrainerNames(filterToThisMonth(allRawSessions));
    const incentive = await getEmployeeIncentiveSummary(employeeId, moment(), { sessions: toSessionRecords(allRawSessions) });

    res.json({
      employee: shapeEmployeeForResponse(employeeId, employeeData, firstName, lastName),
      compliance: computeCompliance(totalHoursThisMonth),
      sessions,
      incentive,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/employees/:id/detail
// Manager/trainer-authorized equivalent of lookupEmployee, keyed by employee ID instead
// of badge number + name. Returns the same { employee, compliance, sessions } shape so
// the frontend can render both with the same component.
export const getEmployeeDetailForManager = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const employeeId = String(req.params.id);
    const doc = await db.collection('employees').doc(employeeId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: { message: 'Employee not found.' } });
    }

    const employeeData = doc.data() as FirebaseFirestore.DocumentData;

    const allRawSessions = await getAllRawSessions(employeeId);
    const { sessions, totalHoursThisMonth } = await resolveSessionsWithTrainerNames(filterToThisMonth(allRawSessions));
    const incentive = await getEmployeeIncentiveSummary(employeeId, moment(), { sessions: toSessionRecords(allRawSessions) });

    res.json({
      employee: shapeEmployeeForResponse(employeeId, employeeData),
      compliance: computeCompliance(totalHoursThisMonth),
      sessions,
      incentive,
    });
  } catch (error) {
    next(error);
  }
};
