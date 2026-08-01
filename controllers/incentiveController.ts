import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';
import { z } from 'zod';
import moment from 'moment';
import { getEmployeeIncentiveSummary } from '../services/incentiveService';
const { clampSitesToScope } = require('../services/authService');

export const tierSchema = z.object({
  body: z.object({
    streakLength: z.number({ message: 'streakLength is required' }).int().positive(),
    rewardLabel: z.string().min(1, 'Reward label is required'),
  })
});

export const updateTierSchema = tierSchema;

function parseSites(value: any): string[] | null {
  if (!value || value === 'all') return null;
  const sites = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  return sites.length > 0 ? sites : null;
}

function displayName(data: any) {
  return data.name || `${data.firstName || ''} ${data.lastName || ''}`.trim();
}

function homeLocationOf(data: any) {
  return data.homeLocation || (data.locations && data.locations[0]) || data.location || 'Unknown';
}

// GET /api/incentives/tiers
export const getAllTiers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const snap = await db.collection('incentiveTiers').get();
    const tiers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    tiers.sort((a: any, b: any) => a.streakLength - b.streakLength);
    res.json(tiers);
  } catch (error) {
    next(error);
  }
};

// POST /api/incentives/tiers
export const createTier = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { streakLength, rewardLabel } = req.body;

    const existing = await db.collection('incentiveTiers').where('streakLength', '==', streakLength).limit(1).get();
    if (!existing.empty) {
      return res.status(409).json({ error: { message: `A tier for a ${streakLength}-month streak already exists.` } });
    }

    const tierData = { streakLength, rewardLabel, createdAt: new Date().toISOString() };
    const docRef = await db.collection('incentiveTiers').add(tierData);
    res.status(201).json({ message: 'Incentive tier added', id: docRef.id, tier: { id: docRef.id, ...tierData } });
  } catch (error) {
    next(error);
  }
};

// PUT /api/incentives/tiers/:id
export const updateTier = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { streakLength, rewardLabel } = req.body;

    const docRef = db.collection('incentiveTiers').doc(id);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ message: 'Incentive tier not found' });
    }

    const existing = await db.collection('incentiveTiers').where('streakLength', '==', streakLength).limit(1).get();
    if (!existing.empty && existing.docs[0].id !== id) {
      return res.status(409).json({ error: { message: `A tier for a ${streakLength}-month streak already exists.` } });
    }

    const updateData = { streakLength, rewardLabel, updatedAt: new Date().toISOString() };
    await docRef.update(updateData);
    res.json({ message: 'Incentive tier updated', id, tier: { id, ...doc.data(), ...updateData } });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/incentives/tiers/:id
export const deleteTier = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const docRef = db.collection('incentiveTiers').doc(id);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ message: 'Incentive tier not found' });
    }
    await docRef.delete();
    res.json({ message: 'Incentive tier deleted' });
  } catch (error) {
    next(error);
  }
};

// Resolves a ?asOf=YYYY-MM query param to the moment the whole computation
// should be evaluated as of. The real current month uses the real current
// moment (so "still time before the 15th" reads correctly); any other month
// uses its own end-of-month, giving a coherent "as it stood back then" view.
function resolveAsOf(asOfParam: string | undefined): moment.Moment {
  const now = moment();
  if (!asOfParam) return now;
  const requested = moment(asOfParam, 'YYYY-MM');
  if (!requested.isValid()) return now;
  if (requested.year() === now.year() && requested.month() === now.month()) return now;
  return requested.endOf('month');
}

// GET /api/incentives/status?asOf=YYYY-MM&sites=A,B
// Roster of active employees (scoped by home site, like the rest of the
// supervisor-facing views) with this-month qualification, streak, current/
// next reward tier, and annual summary — all evaluated as of the requested
// (or current) month.
export const getIncentiveStatus = async (req: any, res: Response, next: NextFunction) => {
  try {
    const asOf = resolveAsOf(req.query.asOf as string);
    const requestedSites = clampSitesToScope(req.user, parseSites(req.query.sites));

    const employeesSnap = await db.collection('employees').where('isActive', '==', true).get();

    const roster = (await Promise.all(employeesSnap.docs.map(async (doc: any) => {
      const data = doc.data();
      const loc = homeLocationOf(data);
      if (requestedSites && !requestedSites.includes(loc)) return null;

      const summary = await getEmployeeIncentiveSummary(doc.id, asOf);
      return {
        employeeId: doc.id,
        name: displayName(data),
        homeLocation: loc,
        ...summary,
      };
    }))).filter(Boolean);

    res.json({
      asOfMonth: asOf.format('YYYY-MM'),
      employees: roster,
      qualifiedCount: roster.filter((r: any) => r.qualifiedThisMonth).length,
      totalCount: roster.length,
    });
  } catch (error) {
    next(error);
  }
};
