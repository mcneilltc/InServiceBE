import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';
import { z } from 'zod';
import moment from 'moment';
import { rolesAtLeast } from '../utils/roles';

export const sessionSchema = z.object({
  body: z.object({
    date: z.string().min(1, "Date is required"),
    location: z.string().min(1, "Location is required"),
    startTime: z.string().optional(),
    length: z.number({ message: "Length is required" }).positive(),
    topics: z.array(z.string()).min(1, "At least one topic is required"),
    trainer: z.union([z.string(), z.array(z.string())]),
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
          topics: session.topics || (session.topic ? [session.topic] : []),
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
        topics: session.topics || (session.topic ? [session.topic] : []),
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

export const createSession = async (req: any, res: Response, next: NextFunction) => {
  try {
    // This is the single endpoint behind both the Manage Employees "Add Hours"
    // dialog and the Excel import's historical-hours step — gating it here
    // covers both surfaces at once. Manual-hours-adding is bundled into
    // Senior Supervisor and up (see utils/roles.ts) — a plain Supervisor
    // never has it. Checked live against Firestore rather than req.user.role
    // (the session JWT's baked-in claim) — that claim is only refreshed on
    // login or requireRole's sliding mid-session renewal (which re-signs the
    // *same* claims), so a demotion would otherwise have no effect on an
    // already-active session for up to ~12 hours. Trainers are unaffected
    // regardless (this was never gated for them).
    if (req.user?.role && req.user.role !== 'trainer') {
      // No employeeId on the session to look up (shouldn't happen for a real
      // login — authService.resolveRole always sets it — but fall back to
      // the JWT claim rather than crashing on Firestore's .doc(falsy)).
      const liveRole = req.user.employeeId
        ? (await db.collection('employees').doc(req.user.employeeId).get()).data()?.role
        : req.user.role;
      if (!rolesAtLeast('seniorSupervisor').includes(liveRole)) {
        return res.status(403).json({
          message: 'You do not have permission to manually add hours for employees. Contact an administrator to request access.',
        });
      }
    }

    const { date, location, startTime, length, topics, trainer, trainees } = req.body;
    const { employeeId } = req.params;

    const employeeDoc = await db.collection('employees').doc(employeeId).get();
    if (!employeeDoc.exists) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Duplicate detection: same employee, same calendar day, and (same location OR any topic overlap)
    const checkForDuplicate = async (employeeId: string, dateStr: string, location: string, topics: string[]) => {
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
        const sTopics: string[] = s.topics || (s.topic ? [s.topic] : []);
        const topicOverlap = sTopics.some((t) => topics.includes(t));
        if ((s.location && s.location === location) || topicOverlap) {
          return { id: doc.id, ...s };
        }
      }
      return null;
    };

    const existing = await checkForDuplicate(employeeId as string, date, location, topics);
    if (existing) {
      return res.status(409).json({ message: 'Duplicate session detected', existing });
    }

    const sessionData = {
      date,
      location,
      startTime: startTime || null,
      length,
      topics,
      trainer,
      trainees: trainees || [],
      status: 'completed',
      createdAt: new Date().toISOString(),
      // Who actually submitted this record — distinct from `trainer` (who
      // led the training), since for a bulk-imported historical entry those
      // are two different people: the importer didn't teach the class, they
      // just entered paperwork for it. Read from the verified session
      // (req.user), never trusted from the request body, so it can't be
      // spoofed by whoever's calling this endpoint.
      createdBy: req.user ? {
        employeeId: req.user.employeeId || null,
        name: req.user.name || null,
        email: req.user.email || null,
      } : null,
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

// Create a top-level training offering (not tied to a specific employee)
export const createTrainingOffering = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { date, location, startTime, length, topics, trainer, trainees } = req.body;
    const topicsArray = Array.isArray(topics) ? topics : (topics ? [topics] : []);

    // Validate required fields
    if (!date || !location || !length || topicsArray.length === 0 || !trainer) {
      return res.status(400).json({
        message: 'Missing required fields: date, location, length, topics, trainer'
      });
    }

    const sessionData = {
      date,
      location,
      startTime: startTime || null,
      length: typeof length === 'number' ? length : parseInt(length, 10),
      topics: topicsArray,
      trainer: Array.isArray(trainer) ? trainer : [trainer],
      trainees: Array.isArray(trainees) ? trainees : [],
      status: 'scheduled',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Create the shared active session record so the UI list and session lookup both see it.
    const docRef = await db.collection('sessions').add(sessionData);

    res.status(201).json({
      message: 'Training offering created successfully',
      sessionId: docRef.id,
      session: { id: docRef.id, ...sessionData }
    });
  } catch (error) {
    next(error);
  }
};
