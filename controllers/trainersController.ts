import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';
import { z } from 'zod';
import * as admin from 'firebase-admin';

export const trainerSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Trainer name is required"),
    email: z.string().min(1, "Trainer email is required").email("Invalid email format"),
    phone: z.string().optional(),
    archived: z.boolean().optional()
  })
});

export const updateTrainerSchema = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    archived: z.boolean().optional()
  })
});

export const getAllTrainers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const includeArchived = req.query.archived === 'true';
    let trainersRef: admin.firestore.Query = db.collection('trainers');
    if (!includeArchived) {
      trainersRef = trainersRef.where('archived', '==', false);
    }
    const trainersSnapshot = await trainersRef.get();
    const trainers: any[] = [];
    trainersSnapshot.forEach((doc: any) => {
      trainers.push({ id: doc.id, ...doc.data() });
    });
    res.json(trainers);
  } catch (error) {
    next(error);
  }
};

export const getTrainerById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const doc = await db.collection('trainers').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ message: 'Trainer not found' });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    next(error);
  }
};

export const createTrainer = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, phone } = req.body;
    const trainerData = {
      name: name.trim(),
      email: email.trim(),
      phone: phone?.trim() || '',
      archived: false,
      createdAt: new Date().toISOString(),
    };
    const docRef = await db.collection('trainers').add(trainerData);
    res.status(201).json({
      message: 'Trainer added',
      id: docRef.id,
      trainer: { id: docRef.id, ...trainerData }
    });
  } catch (error) {
    next(error);
  }
};

export const updateTrainer = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { name, email, phone, archived } = req.body;
    const docRef = db.collection('trainers').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Trainer not found' });
    }

    const updateData: any = {
      updatedAt: new Date().toISOString()
    };
    if (name) updateData.name = name.trim();
    if (email) updateData.email = email.trim();
    if (phone) updateData.phone = phone.trim();
    if (typeof archived === 'boolean') updateData.archived = archived;

    await docRef.update(updateData);
    const updatedDoc = await db.collection('trainers').doc(id).get();
    
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.json({
      message: 'Trainer updated',
      id,
      trainer: { id: updatedDoc.id, ...updatedDoc.data() }
    });
  } catch (error) {
    next(error);
  }
};

export const deleteTrainer = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const docRef = db.collection('trainers').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Trainer not found' });
    }

    const employeesSnapshot = await db.collection('employees').get();
    let hasSessions = false;
    for (const employeeDoc of employeesSnapshot.docs) {
      const sessionsSnapshot = await employeeDoc.ref
        .collection('trainingSessions')
        .where('trainer', '==', id)
        .get();
      if (!sessionsSnapshot.empty) {
        hasSessions = true;
        break;
      }
    }

    if (hasSessions) {
      return res.status(400).json({
        message: 'Cannot delete trainer. Trainer is assigned to existing training sessions.'
      });
    }

    await docRef.delete();
    res.json({ message: 'Trainer deleted' });
  } catch (error) {
    next(error);
  }
};
