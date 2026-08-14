import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';
import { rolesAtLeast } from '../utils/roles';
import {
  WEEK_KEYS,
  emptyWeeks,
  getMandatoryTopicsForMonth,
  getMandatoryTopicsForDate,
} from '../services/mandatoryTopicsService';

const YEAR_MONTH_RE = /^\d{4}-\d{2}$/;

export const getForMonth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const yearMonth = String(req.params.yearMonth);
    if (!YEAR_MONTH_RE.test(yearMonth)) {
      return res.status(400).json({ message: 'yearMonth must be in YYYY-MM format' });
    }
    const weeks = await getMandatoryTopicsForMonth(yearMonth);
    res.json({ weeks });
  } catch (error) {
    next(error);
  }
};

export const getForDate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { date } = req.query;
    if (typeof date !== 'string' || !date) {
      return res.status(400).json({ message: 'date query param (YYYY-MM-DD) is required' });
    }
    const result = await getMandatoryTopicsForDate(date);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

// PUT /:yearMonth — checked live against the acting supervisor's own
// Firestore record, not req.user.role (the session JWT's baked-in claim) —
// same reasoning as the manual-hours check in
// trainingSessionsController.createSession: a claim baked in at login can
// go stale for hours after a demotion, so it must take effect on the very
// next request, not the supervisor's next login. Managing the schedule is
// bundled into Senior Supervisor and up — a plain Supervisor never has it.
export const setForMonth = async (req: any, res: Response, next: NextFunction) => {
  try {
    const yearMonth = String(req.params.yearMonth);
    if (!YEAR_MONTH_RE.test(yearMonth)) {
      return res.status(400).json({ message: 'yearMonth must be in YYYY-MM format' });
    }

    // No employeeId on the session to look up (shouldn't happen for a real
    // login — authService.resolveRole always sets it — but fall back to the
    // JWT claim rather than crashing on Firestore's .doc(falsy)).
    const liveRole = req.user.employeeId
      ? (await db.collection('employees').doc(req.user.employeeId).get()).data()?.role
      : req.user.role;
    if (!rolesAtLeast('seniorSupervisor').includes(liveRole)) {
      return res.status(403).json({
        message: 'You do not have permission to manage the mandatory topics schedule. Contact an administrator to request access.',
      });
    }

    const { weeks } = req.body;
    if (!weeks || typeof weeks !== 'object') {
      return res.status(400).json({ message: 'weeks is required' });
    }

    const cleaned = emptyWeeks();
    for (const key of Object.keys(weeks)) {
      if (!(WEEK_KEYS as readonly string[]).includes(key)) {
        return res.status(400).json({ message: `Invalid week key "${key}" — must be one of 1-5` });
      }
      const value = weeks[key];
      if (!Array.isArray(value) || !value.every((t) => typeof t === 'string')) {
        return res.status(400).json({ message: `weeks["${key}"] must be an array of topic names` });
      }
      cleaned[key] = value;
    }

    await db.collection('mandatoryTopics').doc(yearMonth).set({
      weeks: cleaned,
      updatedAt: new Date().toISOString(),
      updatedByEmployeeId: req.user.employeeId,
    }, { merge: true });

    res.json({ message: 'Mandatory topics schedule updated', weeks: cleaned });
  } catch (error) {
    next(error);
  }
};
