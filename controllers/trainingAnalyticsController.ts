import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';
import moment from 'moment';
import { computeComplianceBySiteForMonth } from './complianceController';
const { clampSitesToScope } = require('../services/authService');

const MONTHLY_THRESHOLD = 4; // hours required by end of month — mirrors complianceController.ts

type Period = 'week' | 'month' | 'year';

function parsePeriod(value: any): Period {
  return value === 'week' || value === 'year' ? value : 'month';
}

function parseSites(value: any): string[] | null {
  if (!value || value === 'all') return null;
  const sites = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  return sites.length > 0 ? sites : null;
}

function computeDateRangeForPeriod(period: Period): { dateStart: Date; dateEnd: Date } {
  const now = new Date();
  if (period === 'week') {
    // Sunday-Saturday, matching routes/dashboard.ts's existing period=week bucketing.
    const dayOfWeek = now.getDay();
    const dateStart = new Date(now);
    dateStart.setDate(now.getDate() - dayOfWeek);
    dateStart.setHours(0, 0, 0, 0);
    const dateEnd = new Date(dateStart);
    dateEnd.setDate(dateStart.getDate() + 6);
    dateEnd.setHours(23, 59, 59, 999);
    return { dateStart, dateEnd };
  }
  if (period === 'year') {
    return {
      dateStart: new Date(now.getFullYear(), 0, 1),
      dateEnd: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
    };
  }
  // month
  return {
    dateStart: new Date(now.getFullYear(), now.getMonth(), 1),
    dateEnd: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
  };
}

// GET /api/training-analytics/sessions?period=week|month|year&sites=A,B
// Topic-frequency and sessions-per-trainer breakdown, computed from the
// top-level `sessions` collection (one doc = one class taught) — NOT the
// per-employee `trainingSessions` subcollection, which would over-count once
// per attendee.
export const getSessionAnalytics = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const period = parsePeriod(req.query.period);
    // `sites` narrows by TRAINING location — a display filter, not a security
    // boundary (mirrors `workSite` in routes/dashboard.ts: a scoped supervisor
    // still needs to see where their own staff trained elsewhere), so this is
    // deliberately NOT clamped via clampSitesToScope.
    const requestedSites = parseSites(req.query.sites);
    const { dateStart, dateEnd } = computeDateRangeForPeriod(period);

    const snapshot = await db.collection('sessions').get();

    const matched: FirebaseFirestore.DocumentData[] = [];
    const trainerIdsToResolve = new Set<string>();

    snapshot.forEach((doc: any) => {
      const s = doc.data();
      if (s.status !== 'completed') return;
      const sessionDate = s.date ? new Date(s.date) : null;
      if (!sessionDate || isNaN(sessionDate.getTime())) return;
      if (sessionDate < dateStart || sessionDate > dateEnd) return;
      if (requestedSites && !requestedSites.includes(s.location)) return;

      matched.push(s);
      const trainerValues: string[] = Array.isArray(s.trainer) ? s.trainer : (s.trainer ? [s.trainer] : []);
      trainerValues.forEach((t) => trainerIdsToResolve.add(t));
    });

    // Resolve trainer IDs to display names, same fallback convention used
    // elsewhere (employeeSelfServiceController.ts): unresolvable values (e.g.
    // already a name, or a malformed legacy value) fall back to the raw value.
    const trainerNameMap = new Map<string, string>();
    await Promise.all(
      Array.from(trainerIdsToResolve).map(async (trainerId) => {
        try {
          const trainerDoc = await db.collection('employees').doc(trainerId).get();
          if (trainerDoc.exists) {
            const data = trainerDoc.data() as any;
            const displayName = data.name || `${data.firstName || ''} ${data.lastName || ''}`.trim();
            if (displayName) trainerNameMap.set(trainerId, displayName);
          }
        } catch {
          // Not a resolvable document ID — leave unresolved, falls back to raw value below.
        }
      })
    );

    const topicCounts: Record<string, number> = {};
    // Grouped by resolved DISPLAY NAME, not raw ID: some legacy sessions store
    // an already-resolved name string instead of an employee ID, so grouping
    // by name is what merges a session referencing an ID with one referencing
    // that same person's name into a single bar. Trade-off: two different
    // people who happen to share a display name would incorrectly merge —
    // acceptable at this org's scale (a handful of sites).
    const trainerCounts: Record<string, number> = {};

    matched.forEach((s) => {
      const topics: string[] = s.topics || (s.topic ? [s.topic] : []);
      topics.forEach((t) => {
        topicCounts[t] = (topicCounts[t] || 0) + 1;
      });

      const trainerValues: string[] = Array.isArray(s.trainer) ? s.trainer : (s.trainer ? [s.trainer] : []);
      trainerValues.forEach((v) => {
        const display = trainerNameMap.get(v) || v;
        trainerCounts[display] = (trainerCounts[display] || 0) + 1;
      });
    });

    const topics = Object.entries(topicCounts)
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count);
    const trainers = Object.entries(trainerCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    res.json({
      period,
      dateRange: { start: dateStart.toISOString(), end: dateEnd.toISOString() },
      totalSessions: matched.length,
      topics,
      trainers,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/training-analytics/compliance-outlook?period=week|month|year&sites=A,B
// Roster-based (grouped by employee HOME site) — this IS the security
// boundary, so `sites` is clamped via clampSitesToScope, mirroring `homeSite`
// in routes/dashboard.ts.
export const getComplianceOutlook = async (req: any, res: Response, next: NextFunction) => {
  try {
    const period = parsePeriod(req.query.period);
    const requestedSites = clampSitesToScope(req.user, parseSites(req.query.sites));

    if (period === 'month') {
      const { bySite, overall } = await computeComplianceBySiteForMonth(moment());
      const scopedBySite = requestedSites
        ? Object.fromEntries(Object.entries(bySite).filter(([site]) => requestedSites.includes(site)))
        : bySite;

      return res.json({
        period: 'month',
        monthKey: moment().format('YYYY-MM'),
        bySite: scopedBySite,
        overall,
      });
    }

    // week and year modes both need every active employee's own session
    // history exactly once, then bucket in-memory — never re-fetch per
    // month/week to avoid multiplying the existing N-employee-subcollection
    // scan cost that compliance/dashboard endpoints already accept today.
    //
    // Fetch ALL active employees (not just the site-filtered subset): the
    // "overall" figure below is always company-wide regardless of the site
    // filter (matching month mode's `overall`, which is likewise never
    // filtered) — only the `bySite` breakdown narrows to `requestedSites`.
    const employeesSnap = await db.collection('employees').where('isActive', '==', true).get();
    const allEmployeeDocs = employeesSnap.docs;

    if (period === 'week') {
      const { dateStart: weekStart, dateEnd: weekEnd } = computeDateRangeForPeriod('week');

      const bySite: Record<string, { totalHoursLoggedThisWeek: number; employeeCount: number }> = {};
      let overallHours = 0;

      await Promise.all(allEmployeeDocs.map(async (doc: any) => {
        const data = doc.data();
        const loc = data.homeLocation || (data.locations && data.locations[0]) || data.location || 'Unknown';
        const sessionsSnap = await doc.ref.collection('trainingSessions').get();

        let hours = 0;
        sessionsSnap.forEach((sd: any) => {
          const s = sd.data();
          const d = s.date ? new Date(s.date) : null;
          if (d && !isNaN(d.getTime()) && d >= weekStart && d <= weekEnd) {
            hours += parseFloat(s.length) || 0;
          }
        });

        // Company-wide total: always every active employee, unaffected by the site filter.
        overallHours += hours;

        if (!requestedSites || requestedSites.includes(loc)) {
          if (!bySite[loc]) bySite[loc] = { totalHoursLoggedThisWeek: 0, employeeCount: 0 };
          bySite[loc].totalHoursLoggedThisWeek = Math.round((bySite[loc].totalHoursLoggedThisWeek + hours) * 10) / 10;
          bySite[loc].employeeCount++;
        }
      }));

      return res.json({
        period: 'week',
        weekRange: { start: weekStart.toISOString(), end: weekEnd.toISOString() },
        bySite,
        overall: {
          totalHoursLoggedThisWeek: Math.round(overallHours * 10) / 10,
          employeeCount: allEmployeeDocs.length,
        },
      });
    }

    // year mode: trailing 12 months, oldest first.
    const monthKeys = Array.from({ length: 12 }, (_, i) => moment().subtract(11 - i, 'months').format('YYYY-MM'));

    const perEmployee = await Promise.all(allEmployeeDocs.map(async (doc: any) => {
      const data = doc.data();
      const loc = data.homeLocation || (data.locations && data.locations[0]) || data.location || 'Unknown';
      const sessionsSnap = await doc.ref.collection('trainingSessions').get(); // ONE fetch per employee, not one per month

      const monthlyHours: Record<string, number> = {};
      sessionsSnap.forEach((sd: any) => {
        const s = sd.data();
        const d = s.date ? new Date(s.date) : null;
        if (!d || isNaN(d.getTime())) return;
        const key = moment(d).format('YYYY-MM');
        monthlyHours[key] = (monthlyHours[key] || 0) + (parseFloat(s.length) || 0);
      });

      return { location: loc, monthlyHours };
    }));

    // Documented simplification: uses the CURRENT active roster for every
    // historical month (no hire/term event log exists to reconstruct past
    // rosters) — same simplification computeComplianceBySiteForMonth already
    // makes implicitly via the isActive filter.
    const scopedForBySite = perEmployee.filter((emp) => !requestedSites || requestedSites.includes(emp.location));

    const bySite: Record<string, { monthKey: string; percentCompliant: number; total: number }[]> = {};
    const overallByMonth: Record<string, { total: number; compliant: number }> = {};

    monthKeys.forEach((key) => { overallByMonth[key] = { total: 0, compliant: 0 }; });
    scopedForBySite.forEach((emp) => { bySite[emp.location] ??= []; });

    for (const key of monthKeys) {
      // Company-wide total: always every active employee, unaffected by the site filter.
      for (const emp of perEmployee) {
        overallByMonth[key].total++;
        if ((emp.monthlyHours[key] || 0) >= MONTHLY_THRESHOLD) overallByMonth[key].compliant++;
      }

      const perSiteThisMonth: Record<string, { total: number; compliant: number }> = {};
      for (const emp of scopedForBySite) {
        perSiteThisMonth[emp.location] ??= { total: 0, compliant: 0 };
        perSiteThisMonth[emp.location].total++;
        if ((emp.monthlyHours[key] || 0) >= MONTHLY_THRESHOLD) perSiteThisMonth[emp.location].compliant++;
      }
      Object.entries(perSiteThisMonth).forEach(([loc, counts]) => {
        bySite[loc].push({
          monthKey: key,
          total: counts.total,
          percentCompliant: counts.total > 0 ? Math.round((counts.compliant / counts.total) * 100) : 0,
        });
      });
    }

    const overall = monthKeys.map((key) => ({
      monthKey: key,
      total: overallByMonth[key].total,
      percentCompliant: overallByMonth[key].total > 0
        ? Math.round((overallByMonth[key].compliant / overallByMonth[key].total) * 100)
        : 0,
    }));

    res.json({ period: 'year', months: monthKeys, bySite, overall });
  } catch (error) {
    next(error);
  }
};
