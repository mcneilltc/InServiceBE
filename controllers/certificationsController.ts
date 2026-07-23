import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';
const { clampSitesToScope } = require('../services/authService');

// GET /api/certifications?sites=MCAC,ERRC
// Returns every active employee within the caller's site scope, each with
// their certifications array (possibly empty — a supervisor auditing
// compliance needs to see "no certification on file" too, not just expiring
// ones). Day-window filtering (30/60/90) is left to the frontend since it's
// a pure display concern, not a scope boundary.
export const getCertificationsOverview = async (req: any, res: Response, next: NextFunction) => {
  try {
    const { sites } = req.query;
    const clientRequestedSites: string[] | null = sites
      ? String(sites).split(',').map((s: string) => s.trim()).filter(Boolean)
      : null;
    // Clamp to the verified session's scope — never trust the client's own claim.
    const requestedSites = clampSitesToScope(req.user, clientRequestedSites);

    const employeesSnapshot = await db.collection('employees').where('isActive', '==', true).get();
    const results: any[] = [];

    employeesSnapshot.forEach((doc: any) => {
      const emp = doc.data();
      // requestedSites === [] means the clamp reduced a scoped supervisor's
      // request to nothing they're allowed to see — must return no rows.
      if (requestedSites && !requestedSites.includes(emp.homeLocation)) return;

      results.push({
        employeeId: doc.id,
        employeeName: emp.name,
        homeLocation: emp.homeLocation || '',
        certifications: Array.isArray(emp.certifications) ? emp.certifications : [],
      });
    });

    res.json(results);
  } catch (error) {
    next(error);
  }
};
