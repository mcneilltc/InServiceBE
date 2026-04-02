import { Request, Response, NextFunction } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { db } from '../config/firebase';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const EXTRACTION_PROMPT = `You are analyzing a photo of a training/inservice sign-in sheet.
Extract ALL of the following information and return it as valid JSON only (no markdown, no explanation):

{
  "trainer": "Name of the instructor/trainer leading the session",
  "topic": "The training topic or subject",
  "date": "Date of the session in YYYY-MM-DD format",
  "startTime": "Start time in HH:MM format (24h), or null if not found",
  "length": "Duration in hours as a number (e.g. 1.5), or null if not found",
  "location": "Location/site name, or null if not found",
  "employees": [
    { "name": "Full name of attendee", "email": "email if visible, else null" }
  ]
}

Rules:
- employees must be an array of every attendee you can read from the sheet
- If a field is illegible or absent, use null
- Return ONLY the JSON object, nothing else`;

export const extractFromSheet = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: { message: 'No image file uploaded' } });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: { message: 'GEMINI_API_KEY is not configured on the server' } });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const imagePart = {
      inlineData: {
        data: req.file.buffer.toString('base64'),
        mimeType: req.file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'image/heif',
      },
    };

    const result = await model.generateContent([EXTRACTION_PROMPT, imagePart]);
    const text = result.response.text().trim();

    // Strip markdown code fences if model wraps in them anyway
    const jsonText = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

    let extracted;
    try {
      extracted = JSON.parse(jsonText);
    } catch {
      return res.status(422).json({
        error: { message: 'Could not parse OCR response as JSON', raw: text }
      });
    }

    // Attempt to fuzzy-match employees and trainer against existing DB records
    const [employeesSnap, trainersSnap, topicsSnap] = await Promise.all([
      db.collection('employees').get(),
      db.collection('trainers').get(),
      db.collection('trainingTopics').get(),
    ]);

    const existingEmployees = employeesSnap.docs.map(d => ({ id: d.id, ...d.data() as any }));
    const existingTrainers = trainersSnap.docs.map(d => ({ id: d.id, ...d.data() as any }));
    const existingTopics = topicsSnap.docs.map(d => ({ id: d.id, ...d.data() as any }));

    // Match each extracted employee name against db (case-insensitive partial match)
    const matchedEmployees = (extracted.employees || []).map((emp: any) => {
      const nameLower = (emp.name || '').toLowerCase();
      const match = existingEmployees.find(e =>
        e.name && e.name.toLowerCase().includes(nameLower) ||
        (nameLower && e.name && nameLower.includes(e.name.toLowerCase()))
      );
      return {
        extractedName: emp.name,
        extractedEmail: emp.email,
        matchedId: match?.id || null,
        matchedName: match?.name || null,
      };
    });

    // Match trainer
    const trainerLower = (extracted.trainer || '').toLowerCase();
    const matchedTrainer = existingTrainers.find(t =>
      t.name && t.name.toLowerCase().includes(trainerLower) ||
      (trainerLower && t.name && trainerLower.includes(t.name.toLowerCase()))
    );

    // Match topic
    const topicLower = (extracted.topic || '').toLowerCase();
    const matchedTopic = existingTopics.find(t =>
      t.name && t.name.toLowerCase().includes(topicLower) ||
      (topicLower && t.name && topicLower.includes(t.name.toLowerCase()))
    );

    res.json({
      extracted,
      matched: {
        trainer: {
          extractedName: extracted.trainer,
          matchedId: matchedTrainer?.id || null,
          matchedName: matchedTrainer?.name || null,
        },
        topic: {
          extractedName: extracted.topic,
          matchedId: matchedTopic?.id || null,
          matchedName: matchedTopic?.name || null,
        },
        employees: matchedEmployees,
      },
      lookups: {
        trainers: existingTrainers.map(t => ({ id: t.id, name: t.name })),
        topics: existingTopics.map(t => ({ id: t.id, name: t.name })),
        employees: existingEmployees.map(e => ({ id: e.id, name: e.name, email: e.email })),
      }
    });
  } catch (error) {
    next(error);
  }
};
