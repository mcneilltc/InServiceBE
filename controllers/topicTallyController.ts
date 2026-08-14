import { Request, Response, NextFunction } from 'express';
import moment from 'moment';
import { db } from '../config/firebase';
import { parseLocalDate } from '../utils/dateParsing';
const { clampSitesToScope } = require('../services/authService');

type Period = 'month' | 'year';

function parsePeriod(value: any): Period {
  return value === 'year' ? 'year' : 'month';
}

function parseSites(value: any): string[] | null {
  if (!value || value === 'all') return null;
  const sites = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  return sites.length > 0 ? sites : null;
}

// Unlike trainingAnalyticsController.ts's computeDateRangeForPeriod (always
// "now"), this accepts an explicit historical month/year so a supervisor can
// look back, not just see the current period — that's the whole point of a
// monthly/yearly tally.
function computeDateRange(period: Period, month: any, year: any): { dateStart: Date; dateEnd: Date } {
  if (period === 'year') {
    const y = moment(String(year), 'YYYY', true).isValid() ? String(year) : moment().format('YYYY');
    const start = moment(y, 'YYYY').startOf('year');
    return { dateStart: start.toDate(), dateEnd: start.clone().endOf('year').toDate() };
  }
  const m = moment(String(month), 'YYYY-MM', true).isValid() ? String(month) : moment().format('YYYY-MM');
  const start = moment(m, 'YYYY-MM').startOf('month');
  return { dateStart: start.toDate(), dateEnd: start.clone().endOf('month').toDate() };
}

interface TallyRow {
  id: string;
  name: string;
  location: string;
  counts: Record<string, number>;
  total: number;
}

// Shared by both endpoints — only the subcollection name differs (employee's
// own credited sessions vs. sessions they led as trainer).
async function buildTally(req: any, subcollection: 'trainingSessions' | 'trainingSessionsLed') {
  const period = parsePeriod(req.query.period);
  const { dateStart, dateEnd } = computeDateRange(period, req.query.month, req.query.year);

  const clientRequestedSites = parseSites(req.query.sites);
  // homeLocation is the roster/security boundary here, same as reports.ts's
  // /hours endpoint — not a training-location filter.
  const requestedSites = clampSitesToScope(req.user, clientRequestedSites);

  const employeesSnapshot = await db.collection('employees').where('isActive', '==', true).get();
  const topicSet = new Set<string>();
  const rows: TallyRow[] = [];

  for (const employeeDoc of employeesSnapshot.docs) {
    const data: any = employeeDoc.data();
    const location = data.homeLocation || (data.locations && data.locations[0]) || 'Unknown';
    if (requestedSites && !requestedSites.includes(location)) continue;

    const sessionsSnapshot = await employeeDoc.ref.collection(subcollection).get();
    const counts: Record<string, number> = {};
    let hasAny = false;

    sessionsSnapshot.forEach((sessionDoc: any) => {
      const session = sessionDoc.data();
      const sessionDate = parseLocalDate(session.date);
      if (!sessionDate || sessionDate < dateStart || sessionDate > dateEnd) return;

      const topics: string[] = Array.isArray(session.topics) ? session.topics : (session.topic ? [session.topic] : []);
      if (topics.length === 0) return;
      hasAny = true;
      for (const topic of topics) {
        if (!topic) continue;
        topicSet.add(topic);
        counts[topic] = (counts[topic] || 0) + 1;
      }
    });

    // Only include people with at least one credited session in range —
    // an empty row for everyone on the roster every period would swamp the
    // table with noise for anyone not actually training/leading that month.
    if (!hasAny) continue;

    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    rows.push({ id: employeeDoc.id, name: data.name || 'Unknown', location, counts, total });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  const topics = [...topicSet].sort();

  return { period, dateStart, dateEnd, topics, rows };
}

// GET /api/topic-tally/employees?period=month|year&month=YYYY-MM&year=YYYY&sites=A,B
// How many times each employee covered each topic, from their own credited
// trainingSessions subcollection.
export const getEmployeeTopicTally = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await buildTally(req, 'trainingSessions'));
  } catch (error) {
    next(error);
  }
};

// GET /api/topic-tally/trainers — same shape, but from trainingSessionsLed
// (credited when this person led a session, regardless of isTrainer/
// isSupervisor — a session's trainer array can include either).
export const getTrainerTopicTally = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await buildTally(req, 'trainingSessionsLed'));
  } catch (error) {
    next(error);
  }
};
