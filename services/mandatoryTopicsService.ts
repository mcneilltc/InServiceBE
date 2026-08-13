import moment from 'moment';
import { db } from '../config/firebase';

export const WEEK_KEYS = ['1', '2', '3', '4', '5'] as const;

// Weeks are day-of-month buckets, not calendar/ISO weeks — this stays
// deterministic regardless of which weekday a month starts on. Week 5 only
// really exists for months with 29+ days (days 29-31); shorter months just
// never populate it.
export function getWeekOfMonth(dateStr: string): number {
  const day = moment(dateStr, 'YYYY-MM-DD', true).date();
  return Math.min(5, Math.ceil(day / 7));
}

export function emptyWeeks(): Record<string, string[]> {
  return { '1': [], '2': [], '3': [], '4': [], '5': [] };
}

export async function getMandatoryTopicsForMonth(yearMonth: string): Promise<Record<string, string[]>> {
  const doc = await db.collection('mandatoryTopics').doc(yearMonth).get();
  if (!doc.exists) return emptyWeeks();
  const data: any = doc.data();
  const weeks = emptyWeeks();
  for (const key of WEEK_KEYS) {
    if (Array.isArray(data.weeks?.[key])) weeks[key] = data.weeks[key];
  }
  return weeks;
}

// The lookup Add Training actually uses — resolves a session's date straight
// to the mandatory topics for its week. Empty when nothing's configured for
// that month/week, so session creation behaves exactly as it does today.
export async function getMandatoryTopicsForDate(dateStr: string): Promise<{ week: number; topics: string[] }> {
  const parsed = moment(dateStr, 'YYYY-MM-DD', true);
  if (!parsed.isValid()) return { week: 0, topics: [] };

  const yearMonth = parsed.format('YYYY-MM');
  const week = getWeekOfMonth(dateStr);
  const weeks = await getMandatoryTopicsForMonth(yearMonth);
  return { week, topics: weeks[String(week)] || [] };
}
