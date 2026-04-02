import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';
import { z } from 'zod';

export const topicSchema = z.object({
  body: z.object({
    topicName: z.string().min(1, "Topic name is required")
  })
});

export const updateTopicSchema = z.object({
  body: z.object({
    topicName: z.string().min(1, "Topic name is required")
  })
});

export const getAllTopics = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const topicsSnapshot = await db.collection('trainingTopics').get();
    const topics: any[] = [];
    topicsSnapshot.forEach((doc: any) => {
      topics.push({ id: doc.id, ...doc.data() });
    });
    res.json(topics);
  } catch (error) {
    next(error);
  }
};

export const getTopicById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const doc = await db.collection('trainingTopics').doc(id).get();
    
    if (!doc.exists) {
      return res.status(404).json({ message: 'Training topic not found' });
    }
    
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    next(error);
  }
};

export const createTopic = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { topicName } = req.body;

    const topicData = {
      name: topicName,
      createdAt: new Date().toISOString()
    };

    const docRef = await db.collection('trainingTopics').add(topicData);
    res.status(201).json({ 
      message: 'Training topic added', 
      id: docRef.id, 
      topic: { id: docRef.id, ...topicData }
    });
  } catch (error) {
    next(error);
  }
};

export const updateTopic = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { topicName } = req.body;

    const docRef = db.collection('trainingTopics').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Training topic not found' });
    }

    const updateData = {
      name: topicName,
      updatedAt: new Date().toISOString()
    };

    await docRef.update(updateData);
    res.json({ 
      message: 'Training topic updated', 
      id, 
      topic: { id, ...doc.data(), ...updateData }
    });
  } catch (error) {
    next(error);
  }
};

export const deleteTopic = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const docRef = db.collection('trainingTopics').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Training topic not found' });
    }

    const employeesSnapshot = await db.collection('employees').get();
    let hasSessions = false;

    for (const employeeDoc of employeesSnapshot.docs) {
      const sessionsSnapshot = await employeeDoc.ref
        .collection('trainingSessions')
        .where('topic', '==', id)
        .get();

      if (!sessionsSnapshot.empty) {
        hasSessions = true;
        break;
      }
    }

    if (hasSessions) {
      return res.status(400).json({ 
        message: 'Cannot delete topic. Topic is used in existing training sessions.' 
      });
    }

    await docRef.delete();
    res.json({ message: 'Training topic deleted' });
  } catch (error) {
    next(error);
  }
};
