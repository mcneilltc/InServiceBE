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

// Sum an employee's recorded training hours within [start, end] inclusive.
async function getHoursInRange(employeeId: string, start: Date, end: Date): Promise<number> {
  const sessionsSnap = await db
    .collection('employees')
    .doc(employeeId)
    .collection('trainingSessions')
    .get();

  let total = 0;
  sessionsSnap.forEach((doc: any) => {
    const session = doc.data();
    const sessionDate = session.date ? new Date(session.date) : null;
    if (sessionDate && sessionDate >= start && sessionDate <= end) {
      total += parseFloat(session.length) || 0;
    }
  });
  return Math.round(total * 100) / 100;
}

// Hours recorded from the 1st through the 15th (inclusive) of the given month.
export async function getHoursByThe15th(employeeId: string, year: number, month: number): Promise<number> {
  const monthMoment = moment({ year, month: month - 1, day: 1 });
  const start = monthMoment.clone().startOf('month').toDate();
  const cutoff = monthMoment.clone().date(15).endOf('day').toDate();
  return getHoursInRange(employeeId, start, cutoff);
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
export async function getMonthQualification(employeeId: string, year: number, month: number, asOf: moment.Moment): Promise<MonthQualification> {
  const hours = await getHoursByThe15th(employeeId, year, month);
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
export async function computeStreak(employeeId: string, asOf: moment.Moment = moment()): Promise<number> {
  let streak = 0;
  let cursor = asOf.clone().startOf('month');

  const current = await getMonthQualification(employeeId, cursor.year(), cursor.month() + 1, asOf);
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
    const result = await getMonthQualification(employeeId, cursor.year(), cursor.month() + 1, asOf);
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
export async function computeAnnualSummary(employeeId: string, year: number, asOf: moment.Moment = moment()): Promise<AnnualSummary> {
  const lastMonth = year === asOf.year() ? asOf.month() + 1 : 12; // 1-12
  let monthsQualified = 0;
  let monthsDecided = 0;
  const months: MonthQualification[] = [];

  for (let month = 1; month <= lastMonth; month++) {
    const result = await getMonthQualification(employeeId, year, month, asOf);
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
// the supervisor tracking roster so all three never drift apart.
export async function getEmployeeIncentiveSummary(employeeId: string, asOf: moment.Moment = moment()): Promise<EmployeeIncentiveSummary> {
  const year = asOf.year();
  const month = asOf.month() + 1;

  const [monthQual, streak, annual, tiers] = await Promise.all([
    getMonthQualification(employeeId, year, month, asOf),
    computeStreak(employeeId, asOf),
    computeAnnualSummary(employeeId, year, asOf),
    getIncentiveTiers(),
  ]);

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
