import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';
import * as admin from 'firebase-admin';
import moment from 'moment';
import { sendEmail, midMonthEmployeeTemplate, managerMidMonthAlertTemplate } from '../services/messagingService';

const MIDMONTH_THRESHOLD = 2;   // hours required by the 15th
const MONTHLY_THRESHOLD  = 4;   // hours required by end of month

interface EmployeeCompliance {
  id: string;
  name: string;
  email: string;
  location: string;
  hoursThisMonth: number;
  status: 'compliant' | 'partial' | 'at_risk' | 'zero';
  hoursNeededByMidMonth: number;
  hoursNeededByEndOfMonth: number;
}

interface SiteSummary {
  total: number;
  compliant: number;  // >= 4 hrs
  partial: number;    // >= 2 but < 4 hrs
  atRisk: number;     // > 0 but < 2 hrs
  zero: number;       // 0 hrs
  percentCompliant: number;
}

// Calculate training hours for an employee within a date range
async function getEmployeeHoursForMonth(employeeId: string, monthStart: Date, monthEnd: Date): Promise<number> {
  const sessionsSnap = await db
    .collection('employees')
    .doc(employeeId)
    .collection('trainingSessions')
    .get();

  let total = 0;
  sessionsSnap.forEach((doc: any) => {
    const session = doc.data();
    const sessionDate = session.date ? new Date(session.date) : null;
    if (sessionDate && sessionDate >= monthStart && sessionDate <= monthEnd) {
      total += parseFloat(session.length) || 0;
    }
  });
  return Math.round(total * 10) / 10; // round to 1dp
}

export const getComplianceStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Accept ?month=YYYY-MM, default to current month
    const monthParam = req.query.month as string;
    const monthMoment = monthParam ? moment(monthParam, 'YYYY-MM') : moment();

    const monthStart  = monthMoment.clone().startOf('month').toDate();
    const monthEnd    = monthMoment.clone().endOf('month').toDate();
    const midMonth    = monthMoment.clone().date(15).endOf('day').toDate();
    const now         = new Date();
    const isMidMonthPassed = now > midMonth;

    // Fetch all active employees
    const employeesSnap = await db.collection('employees').where('isActive', '==', true).get();

    const employees: EmployeeCompliance[] = [];

    await Promise.all(employeesSnap.docs.map(async (doc: any) => {
      const data = doc.data();
      const hours = await getEmployeeHoursForMonth(doc.id, monthStart, monthEnd);

      let status: EmployeeCompliance['status'];
      if (hours >= MONTHLY_THRESHOLD)       status = 'compliant';
      else if (hours >= MIDMONTH_THRESHOLD) status = 'partial';
      else if (hours > 0)                   status = 'at_risk';
      else                                  status = 'zero';

      employees.push({
        id: doc.id,
        name: data.name || 'Unknown',
        email: data.email || '',
        location: data.homeLocation || (data.locations && data.locations[0]) || data.location || 'Unknown',
        hoursThisMonth: hours,
        status,
        hoursNeededByMidMonth: Math.max(0, MIDMONTH_THRESHOLD - hours),
        hoursNeededByEndOfMonth: Math.max(0, MONTHLY_THRESHOLD - hours),
      });
    }));

    // Group by site
    const sites: Record<string, SiteSummary> = {};
    employees.forEach(emp => {
      const loc = emp.location;
      if (!sites[loc]) {
        sites[loc] = { total: 0, compliant: 0, partial: 0, atRisk: 0, zero: 0, percentCompliant: 0 };
      }
      const s = sites[loc];
      s.total++;
      if (emp.status === 'compliant')  s.compliant++;
      else if (emp.status === 'partial') s.partial++;
      else if (emp.status === 'at_risk') s.atRisk++;
      else s.zero++;
    });
    Object.values(sites).forEach(s => {
      s.percentCompliant = s.total > 0 ? Math.round((s.compliant / s.total) * 100) : 0;
    });

    // Alerts
    const midMonthAlerts  = employees.filter(e => e.status === 'zero');     // 0 hrs — manager alert
    const needsNotice     = employees.filter(e => e.status === 'at_risk' || e.status === 'zero'); // < 2 hrs
    const endOfMonthRisk  = employees.filter(e => e.status !== 'compliant'); // < 4 hrs

    // Overall stats
    const total = employees.length;
    const compliantCount = employees.filter(e => e.status === 'compliant').length;

    res.json({
      month: monthMoment.format('MMMM YYYY'),
      monthKey: monthMoment.format('YYYY-MM'),
      isMidMonthPassed,
      thresholds: { midMonth: MIDMONTH_THRESHOLD, endOfMonth: MONTHLY_THRESHOLD },
      overall: {
        total,
        compliant: compliantCount,
        partial: employees.filter(e => e.status === 'partial').length,
        atRisk: employees.filter(e => e.status === 'at_risk').length,
        zero: employees.filter(e => e.status === 'zero').length,
        percentCompliant: total > 0 ? Math.round((compliantCount / total) * 100) : 0,
      },
      bySite: sites,
      alerts: {
        midMonth: midMonthAlerts,     // employees with 0 hrs (manager alert)
        needsNotice,                  // employees needing mid-month notice (< 2 hrs)
        endOfMonth: endOfMonthRisk,   // employees at risk of write-up (< 4 hrs)
      },
      allEmployees: employees,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/compliance/notify-midmonth
export const sendMidMonthNotices = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Determine current month
    const monthMoment = moment();
    const monthStart  = monthMoment.clone().startOf('month').toDate();
    const monthEnd    = monthMoment.clone().endOf('month').toDate();

    const employeesSnap = await db.collection('employees').where('isActive', '==', true).get();
    const needsNotice: any[] = [];
    const managersBySite: Record<string, any[]> = {};

    for (const doc of employeesSnap.docs) {
      const data = doc.data();
      const hours = await getEmployeeHoursForMonth(doc.id, monthStart, monthEnd);
      if (hours < MIDMONTH_THRESHOLD) {
        needsNotice.push({ id: doc.id, name: data.name || `${data.firstName} ${data.lastName}`.trim(), email: data.email || '', location: data.homeLocation || (data.locations && data.locations[0]) || data.location || 'Unknown', hours });
        const site = data.homeLocation || (data.locations && data.locations[0]) || data.location || 'Unknown';
        if (!managersBySite[site]) managersBySite[site] = [];
        if (hours === 0) managersBySite[site].push({ id: doc.id, name: data.name || '', email: data.email || '' });
      }
    }

    // Send employee notices (individual)
    const sendResults = [];
    for (const emp of needsNotice) {
      if (!emp.email) continue;
      const html = midMonthEmployeeTemplate(emp, emp.hours, []);
      const r = await sendEmail(emp.email, 'Action Required: Inservice Hours Needed', html);
      sendResults.push({ to: emp.email, result: r });
    }

    // Send manager alerts for zeros
    for (const [site, list] of Object.entries(managersBySite)) {
      if (!list || list.length === 0) continue;
      // Look up manager email from env or from site config (placeholder)
      const managerEmail = process.env.MANAGER_EMAIL || '';
      if (!managerEmail) continue;
      const html = managerMidMonthAlertTemplate(site, list);
      const r = await sendEmail(managerEmail, `${site} — ${list.length} employees have 0 inservice hours`, html);
      sendResults.push({ to: managerEmail, result: r });
    }

    res.json({ sent: sendResults.length, details: sendResults });
  } catch (error) {
    next(error);
  }
};

// POST /api/compliance/notify-endofmonth
export const sendEndOfMonthAlerts = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const monthMoment = moment();
    const monthStart  = monthMoment.clone().startOf('month').toDate();
    const monthEnd    = monthMoment.clone().endOf('month').toDate();

    const employeesSnap = await db.collection('employees').where('isActive', '==', true).get();
    const atRisk: any[] = [];
    for (const doc of employeesSnap.docs) {
      const data = doc.data();
      const hours = await getEmployeeHoursForMonth(doc.id, monthStart, monthEnd);
      if (hours < MONTHLY_THRESHOLD) {
        atRisk.push({ id: doc.id, name: data.name || `${data.firstName} ${data.lastName}`.trim(), email: data.email || '', location: data.homeLocation || (data.locations && data.locations[0]) || data.location || 'Unknown', hours });
      }
    }

    const managerEmail = process.env.MANAGER_EMAIL || '';
    const trainingTeam = process.env.TRAINING_TEAM_EMAIL || '';
    const recipients = [managerEmail, trainingTeam].filter(Boolean);
    const results = [];
    for (const to of recipients) {
      const html = `<p>Employees not meeting ${MONTHLY_THRESHOLD}-hour requirement:</p><ul>${atRisk.map(a=>`<li>${a.name} — ${a.hours} hrs</li>`).join('')}</ul>`;
      const r = await sendEmail(to, `End of Month Compliance Alert — ${monthMoment.format('MMMM YYYY')}`, html);
      results.push({ to, result: r });
    }

    res.json({ recipients: results.length, details: results });
  } catch (error) {
    next(error);
  }
};
