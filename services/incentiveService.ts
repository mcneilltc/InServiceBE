import { db } from '../config/firebase';
import moment from 'moment';

// The incentive program's eligibility rule: all 4 hours of inservice
// recorded before the 15th of the month. Deliberately independent of the
// separate 2-by-the-15th/4-by-month-end compliance requirement in
// complianceController.ts — this is a stricter, earlier-completion bar tied
// to a reward, not the baseline requirement.
export const INCENTIVE_HOURS_THRESHOLD = 4;

const TIERS_COLLECTION = 'incentiveTiers';

export interface IncentiveTier {
  id: string;
  streakLength: number; // consecutive qualifying months required to reach this tier
  rewardLabel: string;
}

export interface SessionRecord {
  date: Date;
  length: number;
}

// Reads an employee's entire trainingSessions subcollection exactly once.
// Every month-qualification computation below (this month, the streak
// lookback, the annual grid) works off this same in-memory list instead of
// re-querying Firestore per month — the previous version did a fresh full
// subcollection read for every month it looked at, which meant a single
// incentive summary could issue dozens of reads (more for a long streak),
// and the supervisor tracking roster multiplied that by every employee on
// the roster. That amplification is what was burning through the Firestore
// read quota. Exported so callers that already have this employee's session
// docs for another reason (e.g. the self-service lookup, which also needs
// this month's raw sessions) can compute their own SessionRecord[] and pass
// it into getEmployeeIncentiveSummary below instead of triggering a second,
// redundant read of the exact same subcollection.
export async function getAllSessions(employeeId: string): Promise<SessionRecord[]> {
  const sessionsSnap = await db.collection('employees').doc(employeeId).collection('trainingSessions').get();
  const sessions: SessionRecord[] = [];
  sessionsSnap.forEach((doc: any) => {
    const s = doc.data();
    const date = s.date ? new Date(s.date) : null;
    if (date && !isNaN(date.getTime())) {
      sessions.push({ date, length: parseFloat(s.length) || 0 });
    }
  });
  return sessions;
}

function sumHoursInRange(sessions: SessionRecord[], start: Date, end: Date): number {
  let total = 0;
  for (const s of sessions) {
    if (s.date >= start && s.date <= end) total += s.length;
  }
  return Math.round(total * 100) / 100;
}

// Hours recorded from the 1st through the 15th (inclusive) of the given month.
function hoursByThe15thFrom(sessions: SessionRecord[], year: number, month: number): number {
  const monthMoment = moment({ year, month: month - 1, day: 1 });
  const start = monthMoment.clone().startOf('month').toDate();
  const cutoff = monthMoment.clone().date(15).endOf('day').toDate();
  return sumHoursInRange(sessions, start, cutoff);
}

export interface MonthQualification {
  year: number;
  month: number; // 1-12
  hours: number;
  // undefined = the 15th hasn't passed yet and hours haven't hit the
  // threshold, so this month's outcome isn't decided one way or the other yet.
  qualified: boolean | undefined;
}

// A month's qualification, from the perspective of `asOf` (normally "now").
// If hours already hit the threshold, it's qualified regardless of date —
// that's locked in early, which is the whole point of the incentive. If the
// threshold isn't met and the 15th has already passed (relative to asOf),
// it's a confirmed miss. Otherwise (still time left before the 15th), the
// outcome is undecided.
function monthQualificationFrom(sessions: SessionRecord[], year: number, month: number, asOf: moment.Moment): MonthQualification {
  const hours = hoursByThe15thFrom(sessions, year, month);
  if (hours >= INCENTIVE_HOURS_THRESHOLD) {
    return { year, month, hours, qualified: true };
  }
  const the15th = moment({ year, month: month - 1, day: 15 }).endOf('day');
  if (asOf.isAfter(the15th)) {
    return { year, month, hours, qualified: false };
  }
  return { year, month, hours, qualified: undefined };
}

// Consecutive qualifying months, walking backward from the current month.
// The current month counts toward the streak as soon as it's qualified
// (even before the 15th) — an early win is locked in immediately. If the
// current month's 15th has passed without qualifying, the streak is 0. If
// the 15th hasn't passed and the threshold isn't met yet, the current month
// is skipped (undecided) and the streak reflects fully-decided prior months.
function streakFrom(sessions: SessionRecord[], asOf: moment.Moment): number {
  let streak = 0;
  let cursor = asOf.clone().startOf('month');

  const current = monthQualificationFrom(sessions, cursor.year(), cursor.month() + 1, asOf);
  if (current.qualified === false) {
    return 0;
  }
  if (current.qualified === true) {
    streak += 1;
  }
  cursor = cursor.subtract(1, 'month');

  // Walk backward through fully-elapsed prior months until one doesn't qualify.
  // Cap the lookback so sparse/new employee history can't spin for years.
  const MAX_LOOKBACK_MONTHS = 60;
  for (let i = 0; i < MAX_LOOKBACK_MONTHS; i++) {
    const result = monthQualificationFrom(sessions, cursor.year(), cursor.month() + 1, asOf);
    if (result.qualified !== true) break;
    streak += 1;
    cursor = cursor.subtract(1, 'month');
  }

  return streak;
}

export interface AnnualSummary {
  year: number;
  monthsQualified: number;
  monthsDecided: number; // months whose outcome (pass or fail) is already settled
  months: MonthQualification[]; // Jan through the last computed month, for a full-year grid
}

// Jan through the current month (or all 12, for a past year) of the given
// year — how many were qualified vs. how many are already decided one way
// or the other (excludes any still-undecided current month), plus the full
// per-month breakdown for displaying a yearly grid.
function annualSummaryFrom(sessions: SessionRecord[], year: number, asOf: moment.Moment): AnnualSummary {
  const lastMonth = year === asOf.year() ? asOf.month() + 1 : 12; // 1-12
  let monthsQualified = 0;
  let monthsDecided = 0;
  const months: MonthQualification[] = [];

  for (let month = 1; month <= lastMonth; month++) {
    const result = monthQualificationFrom(sessions, year, month, asOf);
    months.push(result);
    if (result.qualified === undefined) continue;
    monthsDecided++;
    if (result.qualified) monthsQualified++;
  }

  return { year, monthsQualified, monthsDecided, months };
}

export interface TierInfo {
  currentTier: IncentiveTier | null;
  nextTier: IncentiveTier | null;
}

// tiers must be pre-sorted ascending by streakLength.
export function getTierInfo(streak: number, tiers: IncentiveTier[]): TierInfo {
  let currentTier: IncentiveTier | null = null;
  let nextTier: IncentiveTier | null = null;

  for (const tier of tiers) {
    if (tier.streakLength <= streak) {
      currentTier = tier;
    } else {
      nextTier = tier;
      break;
    }
  }

  return { currentTier, nextTier };
}

export async function getIncentiveTiers(): Promise<IncentiveTier[]> {
  const snap = await db.collection(TIERS_COLLECTION).get();
  const tiers = snap.docs.map((d) => ({ id: d.id, ...d.data() } as IncentiveTier));
  return tiers.sort((a, b) => a.streakLength - b.streakLength);
}

export interface EmployeeIncentiveSummary {
  monthKey: string;
  hoursByThe15th: number;
  hoursNeeded: number;
  qualifiedThisMonth: boolean | undefined;
  deadlinePassed: boolean;
  currentStreak: number;
  currentTier: IncentiveTier | null;
  nextTier: IncentiveTier | null;
  monthsUntilNextTier: number | null;
  annual: AnnualSummary;
}

// Everything one employee's incentive card/row needs, computed in one call —
// shared by the self-service lookup, the manager employee-detail view, and
// the supervisor tracking roster so all three never drift apart. Issues
// exactly one Firestore read of the employee's session history (plus one for
// the tiers list), no matter how long their streak or how many months are
// being summarized — or zero reads for whichever of those two a caller
// already has in hand, via `preloaded`. The roster endpoint (one shared
// tiers list for every employee) and the self-service lookup (already reads
// this same employee's sessions for another reason) both use this to avoid
// re-fetching data the caller already has.
export async function getEmployeeIncentiveSummary(
  employeeId: string,
  asOf: moment.Moment = moment(),
  preloaded?: { sessions?: SessionRecord[]; tiers?: IncentiveTier[] }
): Promise<EmployeeIncentiveSummary> {
  const year = asOf.year();
  const month = asOf.month() + 1;

  const [sessions, tiers] = await Promise.all([
    preloaded?.sessions ?? getAllSessions(employeeId),
    preloaded?.tiers ?? getIncentiveTiers(),
  ]);

  const monthQual = monthQualificationFrom(sessions, year, month, asOf);
  const streak = streakFrom(sessions, asOf);
  const annual = annualSummaryFrom(sessions, year, asOf);

  const { currentTier, nextTier } = getTierInfo(streak, tiers);
  const the15th = moment({ year, month: month - 1, day: 15 }).endOf('day');

  return {
    monthKey: asOf.format('YYYY-MM'),
    hoursByThe15th: monthQual.hours,
    hoursNeeded: Math.max(0, INCENTIVE_HOURS_THRESHOLD - monthQual.hours),
    qualifiedThisMonth: monthQual.qualified,
    deadlinePassed: asOf.isAfter(the15th),
    currentStreak: streak,
    currentTier,
    nextTier,
    monthsUntilNextTier: nextTier ? nextTier.streakLength - streak : null,
    annual,
  };
}
