import { db } from '../config/firebase';
import moment from 'moment';
import { parseLocalDate } from '../utils/dateParsing';

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

// Bulk Excel import (Manage Employees → Import from Excel) backfills
// historical hours by creating a training-session record dated the 1st of
// whatever month it's crediting, tagged with the literal trainer value
// 'Imported' instead of a real trainer ID. The 1st is always before the
// 15th, so — left unfiltered — a backdated import for ANY past month would
// automatically read as "completed before the 15th" and silently hand out
// incentive qualification/streak credit for a month nobody actually
// verified was finished on time. Imported hours still count everywhere else
// (compliance status, dashboard totals, the Employee Hours report) — this
// exclusion is specific to the incentive program, whose whole premise is
// rewarding genuine on-time completion, never paperwork entered after the fact.
// Exported so other callers building their own SessionRecord[] from
// already-fetched raw session docs (instead of calling getAllSessions below)
// apply the exact same exclusion rather than reimplementing — and can't
// silently drift out of sync with it.
export function isBulkImportedSession(s: FirebaseFirestore.DocumentData): boolean {
  return s.trainer === 'Imported';
}

// A supervisor's manual correction of one employee's one month — e.g. a
// paper sign-in sheet surfaces after the fact, or hours were logged under
// the wrong employee/date and can't cleanly be re-attributed. Stored as a
// per-employee subcollection (mirroring trainingSessions) rather than a
// top-level collection, so "all overrides for employee X" is a bare
// subcollection read with no where() clause, and archived employees' (soft
// deleted, see employeesController.js) overrides fall out of the roster for
// free the same way their trainingSessions already do.
const OVERRIDES_SUBCOLLECTION = 'incentiveOverrides';

export interface IncentiveOverride {
  year: number;
  month: number; // 1-12
  qualified: boolean;
  note?: string;
  setByEmployeeId: string;
  setByName: string;
  updatedAt: string; // ISO
}

const EMPTY_OVERRIDES: Map<string, IncentiveOverride> = new Map();

function overrideKey(year: number, month: number): string {
  return `${year}-${month}`;
}

// One subcollection read regardless of how many months are being looked at
// (this month, a long streak's lookback, a full annual grid) — same
// one-read-per-employee philosophy as getAllSessions below.
export async function getIncentiveOverrides(employeeId: string): Promise<Map<string, IncentiveOverride>> {
  const snap = await db.collection('employees').doc(employeeId).collection(OVERRIDES_SUBCOLLECTION).get();
  const map = new Map<string, IncentiveOverride>();
  snap.forEach((doc: any) => map.set(doc.id, doc.data() as IncentiveOverride));
  return map;
}

export async function setIncentiveOverride(
  employeeId: string,
  year: number,
  month: number,
  qualified: boolean,
  note: string | undefined,
  setBy: { employeeId: string; name: string }
): Promise<void> {
  const key = overrideKey(year, month);
  const override: IncentiveOverride = {
    year,
    month,
    qualified,
    ...(note ? { note } : {}),
    setByEmployeeId: setBy.employeeId,
    setByName: setBy.name,
    updatedAt: new Date().toISOString(),
  };
  await db.collection('employees').doc(employeeId).collection(OVERRIDES_SUBCOLLECTION).doc(key).set(override);
}

export async function clearIncentiveOverride(employeeId: string, year: number, month: number): Promise<void> {
  await db.collection('employees').doc(employeeId).collection(OVERRIDES_SUBCOLLECTION).doc(overrideKey(year, month)).delete();
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
    if (isBulkImportedSession(s)) return;
    const date = parseLocalDate(s.date);
    if (date) {
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
  isOverride?: boolean;
  overrideNote?: string;
  overrideSetByName?: string;
  overrideSetAt?: string;
}

// A month's qualification, from the perspective of `asOf` (normally "now").
// A manual override always wins first — a supervisor's correction of the
// record, not a recomputation of it, so the real `hours` are still returned
// alongside it for context ("3 of 4 hours, but manually marked qualified")
// and are never altered by the override (an override never un-excludes
// bulk-imported hours, see isBulkImportedSession above — it only overrides
// the outcome). Absent an override: if hours already hit the threshold,
// it's qualified regardless of date — that's locked in early, which is the
// whole point of the incentive. If the threshold isn't met and the 15th has
// already passed (relative to asOf), it's a confirmed miss. Otherwise
// (still time left before the 15th), the outcome is undecided.
function monthQualificationFrom(
  sessions: SessionRecord[],
  year: number,
  month: number,
  asOf: moment.Moment,
  overrides: Map<string, IncentiveOverride> = EMPTY_OVERRIDES
): MonthQualification {
  const hours = hoursByThe15thFrom(sessions, year, month);

  const override = overrides.get(overrideKey(year, month));
  if (override) {
    return {
      year,
      month,
      hours,
      qualified: override.qualified,
      isOverride: true,
      ...(override.note ? { overrideNote: override.note } : {}),
      overrideSetByName: override.setByName,
      overrideSetAt: override.updatedAt,
    };
  }

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
function streakFrom(sessions: SessionRecord[], asOf: moment.Moment, overrides: Map<string, IncentiveOverride> = EMPTY_OVERRIDES): number {
  let streak = 0;
  let cursor = asOf.clone().startOf('month');

  const current = monthQualificationFrom(sessions, cursor.year(), cursor.month() + 1, asOf, overrides);
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
    const result = monthQualificationFrom(sessions, cursor.year(), cursor.month() + 1, asOf, overrides);
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
function annualSummaryFrom(
  sessions: SessionRecord[],
  year: number,
  asOf: moment.Moment,
  overrides: Map<string, IncentiveOverride> = EMPTY_OVERRIDES
): AnnualSummary {
  const lastMonth = year === asOf.year() ? asOf.month() + 1 : 12; // 1-12
  let monthsQualified = 0;
  let monthsDecided = 0;
  const months: MonthQualification[] = [];

  for (let month = 1; month <= lastMonth; month++) {
    const result = monthQualificationFrom(sessions, year, month, asOf, overrides);
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
  qualifiedThisMonthIsOverride?: boolean;
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
  preloaded?: { sessions?: SessionRecord[]; tiers?: IncentiveTier[]; overrides?: Map<string, IncentiveOverride> }
): Promise<EmployeeIncentiveSummary> {
  const year = asOf.year();
  const month = asOf.month() + 1;

  const [sessions, tiers, overrides] = await Promise.all([
    preloaded?.sessions ?? getAllSessions(employeeId),
    preloaded?.tiers ?? getIncentiveTiers(),
    preloaded?.overrides ?? getIncentiveOverrides(employeeId),
  ]);

  const monthQual = monthQualificationFrom(sessions, year, month, asOf, overrides);
  const streak = streakFrom(sessions, asOf, overrides);
  const annual = annualSummaryFrom(sessions, year, asOf, overrides);

  const { currentTier, nextTier } = getTierInfo(streak, tiers);
  const the15th = moment({ year, month: month - 1, day: 15 }).endOf('day');

  return {
    monthKey: asOf.format('YYYY-MM'),
    hoursByThe15th: monthQual.hours,
    hoursNeeded: Math.max(0, INCENTIVE_HOURS_THRESHOLD - monthQual.hours),
    qualifiedThisMonth: monthQual.qualified,
    ...(monthQual.isOverride ? { qualifiedThisMonthIsOverride: true } : {}),
    deadlinePassed: asOf.isAfter(the15th),
    currentStreak: streak,
    currentTier,
    nextTier,
    monthsUntilNextTier: nextTier ? nextTier.streakLength - streak : null,
    annual,
  };
}
