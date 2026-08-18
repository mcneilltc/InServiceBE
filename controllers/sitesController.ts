import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';
import { z } from 'zod';

export const siteSchema = z.object({
  body: z.object({
    siteName: z.string().min(1, "Site name is required"),
    // The short acronym (siteName, e.g. "ERRC") stays the canonical value
    // used everywhere for data entry/reporting/filtering — fullName is
    // purely a supplementary label for the sites that read a set of
    // initials on their own (e.g. "Eastway Regional Recreation Center").
    fullName: z.string().trim().optional(),
  })
});

export const updateSiteSchema = z.object({
  body: z.object({
    siteName: z.string().min(1, "Site name is required"),
    fullName: z.string().trim().optional(),
  })
});

export const getAllSites = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sitesSnapshot = await db.collection('sites').get();
    const sites: any[] = [];
    sitesSnapshot.forEach((doc: any) => {
      sites.push({ id: doc.id, ...doc.data() });
    });
    res.json(sites);
  } catch (error) {
    next(error);
  }
};

export const getSiteById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const doc = await db.collection('sites').doc(id).get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Site not found' });
    }

    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    next(error);
  }
};

export const createSite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { siteName, fullName } = req.body;
    const trimmedName = siteName.trim();

    const existing = await db.collection('sites').where('name', '==', trimmedName).limit(1).get();
    if (!existing.empty) {
      return res.status(409).json({ error: { message: `A site named "${trimmedName}" already exists.` } });
    }

    const siteData = {
      name: trimmedName,
      fullName: fullName ? fullName.trim() : null,
      createdAt: new Date().toISOString()
    };

    const docRef = await db.collection('sites').add(siteData);
    res.status(201).json({
      message: 'Site added',
      id: docRef.id,
      site: { id: docRef.id, ...siteData }
    });
  } catch (error) {
    next(error);
  }
};

export const updateSite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { siteName, fullName } = req.body;
    const trimmedName = siteName.trim();

    const docRef = db.collection('sites').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Site not found' });
    }

    const existing = await db.collection('sites').where('name', '==', trimmedName).limit(1).get();
    if (!existing.empty && existing.docs[0].id !== id) {
      return res.status(409).json({ error: { message: `A site named "${trimmedName}" already exists.` } });
    }

    const updateData: any = {
      name: trimmedName,
      updatedAt: new Date().toISOString()
    };
    if (fullName !== undefined) updateData.fullName = fullName ? fullName.trim() : null;

    await docRef.update(updateData);
    res.json({
      message: 'Site updated',
      id,
      site: { id, ...doc.data(), ...updateData }
    });
  } catch (error) {
    next(error);
  }
};

export const deleteSite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const docRef = db.collection('sites').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Site not found' });
    }

    const siteName = doc.data()?.name;

    // Sites are live roster state (an employee's current home/assigned
    // locations), not a historical record like session topics — so unlike
    // topics, a site in active use must block deletion entirely rather than
    // just warning, to avoid leaving employees pointed at a vanished site.
    const [homeMatch, locationsMatch] = await Promise.all([
      db.collection('employees').where('homeLocation', '==', siteName).limit(1).get(),
      db.collection('employees').where('locations', 'array-contains', siteName).limit(1).get(),
    ]);

    if (!homeMatch.empty || !locationsMatch.empty) {
      return res.status(400).json({
        error: { message: `Cannot delete "${siteName}". It is still assigned to one or more employees — reassign them first.` }
      });
    }

    await docRef.delete();
    res.json({ message: 'Site deleted' });
  } catch (error) {
    next(error);
  }
};
