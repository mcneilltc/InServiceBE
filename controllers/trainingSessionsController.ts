import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';
import { z } from 'zod';

export const sessionSchema = z.object({
  body: z.object({
    date: z.string().min(1, "Date is required"),
    location: z.string().min(1, "Location is required"),
    startTime: z.string().optional(),
    length: z.number({ message: "Length is required" }).positive(),
    topic: z.string().min(1, "Topic is required"),
    trainer: z.string().min(1, "Trainer is required"),
    trainees: z.array(z.string()).optional()
  })
});

export const getAllSessions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const allSessions: any[] = [];
    const employeesSnapshot = await db.collection('employees').get();

    for (const employeeDoc of employeesSnapshot.docs) {
      const sessionsSnapshot = await employeeDoc.ref.collection('trainingSessions').get();
      
      sessionsSnapshot.forEach((sessionDoc: any) => {
        const session = sessionDoc.data();
        allSessions.push({
          id: sessionDoc.id,
          topic: session.topic,
          trainer: session.trainer,
          date: session.date,
          participants: session.trainees ? session.trainees.length : 0,
          status: session.status || 'completed'
        });
      });
    }

    res.json(allSessions);
  } catch (error) {
    next(error);
  }
};

export const getEmployeeSessions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { employeeId } = req.params;
    const employeeDoc = await db.collection('employees').doc(employeeId).get();
    if (!employeeDoc.exists) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const sessionsSnapshot = await db
      .collection('employees')
      .doc(employeeId)
      .collection('trainingSessions')
      .get();

    const sessions: any[] = [];
    sessionsSnapshot.forEach((doc: any) => {
      const session = doc.data();
      sessions.push({
        id: doc.id,
        topic: session.topic,
        trainer: session.trainer,
        date: session.date,
        participants: session.trainees ? session.trainees.length : 0,
        status: session.status || 'completed'
      });
    });

    res.json(sessions);
  } catch (error) {
    next(error);
  }
};

export const createSession = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { date, location, startTime, length, topic, trainer, trainees } = req.body;
    const { employeeId } = req.params;

    const employeeDoc = await db.collection('employees').doc(employeeId).get();
    if (!employeeDoc.exists) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Duplicate detection: same employee, same calendar day, and (same location OR same topic)
    const checkForDuplicate = async (employeeId: string, dateStr: string, location: string, topic: string) => {
      const dayStart = moment(dateStr).startOf('day').toDate();
      const dayEnd = moment(dateStr).endOf('day').toDate();
      const sessionsSnap = await db
        .collection('employees')
        .doc(employeeId)
        .collection('trainingSessions')
        .where('date', '>=', dayStart.toISOString())
        .where('date', '<=', dayEnd.toISOString())
        .get();

      for (const doc of sessionsSnap.docs) {
        const s = doc.data();
        if ((s.location && s.location === location) || (s.topic && s.topic === topic)) {
          return { id: doc.id, ...s };
        }
      }
      return null;
    };

    const existing = await checkForDuplicate(employeeId, date, location, topic);
    if (existing) {
      return res.status(409).json({ message: 'Duplicate session detected', existing });
    }

    const sessionData = {
      date,
      location,
      startTime: startTime || null,
      length,
      topic,
      trainer,
      trainees: trainees || [],
      status: 'completed',
      createdAt: new Date().toISOString()
    };

    const docRef = await db
      .collection('employees')
      .doc(employeeId)
      .collection('trainingSessions')
      .add(sessionData);

    const currentHours = employeeDoc.data().totalHours || 0;
    await db
      .collection('employees')
      .doc(employeeId)
      .update({
        totalHours: currentHours + parseFloat(length),
        updatedAt: new Date().toISOString()
      });

    res.status(201).json({ 
      message: 'Training session added', 
      sessionId: docRef.id, 
      session: { id: docRef.id, ...sessionData }
    });
  } catch (error) {
    next(error);
  }
};
