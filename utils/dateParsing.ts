import moment from 'moment';

// A bare "YYYY-MM-DD" string (as stored on trainingSessions.date, checkin
// query params, etc.) is meant to represent a calendar day, not a UTC
// instant — but the native Date constructor parses date-only ISO strings as
// UTC midnight. In any timezone behind UTC (this app runs in
// America/New_York), UTC midnight of a day is *before* that day's local
// midnight, which silently shifts day-1 dates into the previous local
// day/month whenever they're compared against a boundary built from
// moment().startOf(...)/.endOf(...) (which are local-time based) — e.g. an
// employee's hours for a session dated "2026-06-01" would be counted toward
// May instead of June. moment() parses the same bare string as local
// midnight instead, matching those boundaries, so use this any time a
// stored date string will be compared against one.
export function parseLocalDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  const m = moment(dateStr);
  return m.isValid() ? m.toDate() : null;
}
