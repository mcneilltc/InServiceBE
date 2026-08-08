import { Request, Response, NextFunction } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { db, getBucket } from '../config/firebase';
import moment from 'moment';
import sharp from 'sharp';
import { randomUUID, createHash } from 'crypto';
import { findDuplicateSheetSession, findSimilarSheetSession } from '../services/sheetDuplicateCheck';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Vision-model token cost scales with image dimensions, and phone photos of a
// sign-in sheet are typically far higher resolution than OCR needs. Downscaling
// before the Gemini call cuts input tokens (and therefore cost) with no loss of
// legibility for printed/handwritten text on a standard sheet.
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 85;

async function prepareImageForOcr(buffer: Buffer, mimeType: string): Promise<{ data: string; mimeType: string }> {
  try {
    const resized = await sharp(buffer)
      .rotate() // respect EXIF orientation before resizing
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    return { data: resized.toString('base64'), mimeType: 'image/jpeg' };
  } catch (error) {
    // sharp's HEIC/HEIF decode support varies by build (Apple's HEVC-based
    // HEIC in particular isn't always included) — fall back to the original
    // image rather than fail the upload if resizing doesn't work for it.
    console.warn('Image resize before OCR failed, sending original:', (error as Error).message);
    return { data: buffer.toString('base64'), mimeType };
  }
}

// Persists the original uploaded sheet photos to Cloud Storage so the source
// document backing a session survives past the OCR request — previously
// these were only ever held in memory for the Gemini call, then discarded.
// Deliberately fails open: if Storage isn't reachable (e.g. not yet enabled
// for this Firebase project), extraction still succeeds without image URLs
// rather than blocking the whole upload flow on a non-essential step.
async function persistSheetImages(files: Express.Multer.File[]): Promise<string[]> {
  const urls: string[] = [];
  for (const file of files) {
    try {
      const ext = (file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const path = `sign-in-sheets/${moment().format('YYYY/MM')}/${randomUUID()}.${ext}`;
      const blob = getBucket().file(path);
      await blob.save(file.buffer, { contentType: file.mimetype });
      const [url] = await blob.getSignedUrl({ action: 'read', expires: '01-01-2100' });
      urls.push(url);
    } catch (error) {
      console.warn('Failed to persist sign-in sheet image (Cloud Storage may not be enabled for this project):', (error as Error).message);
    }
  }
  return urls;
}

const EXTRACTION_PROMPT = `You are analyzing photos of a training/inservice sign-in packet. The images provided together make up ONE packet and may include two kinds of pages:
1. Sign-in sheet page(s) — each lists attendees who signed in for the session (name, site/location, sometimes email), plus the overall trainer, date, and start/end time for the session at the top.
2. A topics-checklist page — lists candidate training topics with a checkbox (or similar mark) next to each. Only topics that are actually checked/marked were covered in this session.

Combine information across ALL provided images as pages of the same packet and return a single JSON object, valid JSON only (no markdown, no explanation):

{
  "trainer": "Name of the instructor/trainer leading the session",
  "topics": ["Each training topic that is checked/marked on the topics-checklist page"],
  "date": "Date of the session in YYYY-MM-DD format",
  "startTime": "Overall start time of the training for the whole session, in HH:MM format (24h), or null if not found",
  "endTime": "Overall end time of the training for the whole session, in HH:MM format (24h), or null if not found",
  "location": "Location/site name, or null if not found",
  "employees": [
    { "name": "Full name of attendee", "site": "Location/site name", "email": "email if visible, else null" }
  ]
}

Rules:
- startTime and endTime describe the training session as a whole (from the top of the sign-in sheet), not each individual attendee's own sign-in/out times
- topics must only include items that are checked/marked on the topics-checklist page — do not include unchecked items
- employees must be an array of every attendee you can read across all sign-in sheet pages (de-duplicate the same person if they appear more than once)
- If a field is illegible or absent, use null (topics and employees should be [] if none found)
- Return ONLY the JSON object, nothing else`;

export const extractFromSheet = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: { message: 'No image files uploaded' } });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: { message: 'GEMINI_API_KEY is not configured on the server' } });
    }

    // Hash the raw uploaded bytes (before any resizing) so re-uploading the
    // exact same photo — whether by accident or to double-dip hours —
    // always produces the same fingerprint. Checked before the (paid)
    // Gemini call so a duplicate fails fast instead of burning OCR cost.
    const sheetImageHashes = files.map((file) => createHash('sha256').update(file.buffer).digest('hex'));
    const duplicate = await findDuplicateSheetSession(sheetImageHashes);
    if (duplicate) {
      return res.status(409).json({
        error: {
          message: `This sign-in sheet was already uploaded and credited — it matches the session on ${duplicate.date || 'an earlier date'} at ${duplicate.location || 'an unknown location'}. If this is a correction, edit that session instead of uploading it again.`,
          duplicateSessionId: duplicate.sessionId,
        },
      });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

    // Kick off persistence alongside the OCR-prep resize — independent of
    // it, so a Storage hiccup can't slow down or fail extraction.
    const persistPromise = persistSheetImages(files);

    const imageParts = await Promise.all(files.map(async file => {
      const { data, mimeType } = await prepareImageForOcr(file.buffer, file.mimetype);
      return { inlineData: { data, mimeType } };
    }));

    const result = await model.generateContent([EXTRACTION_PROMPT, ...imageParts]);
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

    // Compute overall session duration (hours) from start/end time, if both are present
    if (extracted.startTime && extracted.endTime) {
      const start = moment(extracted.startTime, ['HH:mm', 'h:mm A']);
      let end = moment(extracted.endTime, ['HH:mm', 'h:mm A']);
      if (start.isValid() && end.isValid()) {
        if (end.isBefore(start)) end = end.add(1, 'day'); // handle sessions that cross midnight
        extracted.length = Math.round(end.diff(start, 'minutes') / 60 * 100) / 100;
      }
    }

    // Attempt to fuzzy-match employees and trainer against existing DB records.
    // Trainers are just employees with isTrainer === true — no separate collection.
    const [employeesSnap, topicsSnap] = await Promise.all([
      db.collection('employees').get(),
      db.collection('trainingTopics').get(),
    ]);

    const existingEmployees = employeesSnap.docs.map(d => ({ id: d.id, ...d.data() as any }));
    const existingTrainers = existingEmployees.filter((e: any) => e.isTrainer);
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

    // Match each extracted (checked) topic against db (case-insensitive partial match)
    const matchedTopics = (extracted.topics || []).map((topicName: string) => {
      const topicLower = (topicName || '').toLowerCase();
      const match = existingTopics.find(t =>
        t.name && t.name.toLowerCase().includes(topicLower) ||
        (topicLower && t.name && topicLower.includes(t.name.toLowerCase()))
      );
      return {
        extractedName: topicName,
        matchedId: match?.id || null,
        matchedName: match?.name || null,
      };
    });

    const sheetImageUrls = await persistPromise;

    // Second layer — catches the same physical sheet photographed twice
    // (different bytes, same session) instead of the exact same file
    // re-uploaded. This is a warning surfaced to the uploader for review,
    // not a block: a real second session can legitimately match.
    const possibleDuplicate = await findSimilarSheetSession(
      extracted.date,
      extracted.location,
      matchedTrainer?.id ? [matchedTrainer.id] : [],
      matchedTopics.map((t: any) => t.matchedName || t.extractedName).filter(Boolean),
    );

    res.json({
      extracted,
      sheetImageUrls,
      sheetImageHashes,
      possibleDuplicate,
      matched: {
        trainer: {
          extractedName: extracted.trainer,
          matchedId: matchedTrainer?.id || null,
          matchedName: matchedTrainer?.name || null,
        },
        topics: matchedTopics,
        employees: matchedEmployees,
      },
      lookups: {
        trainers: existingTrainers.map((t: any) => ({ id: t.id, name: t.name, email: t.email, isSupervisor: !!t.isSupervisor })),
        topics: existingTopics.map((t: any) => ({ id: t.id, name: t.name, requiresDetail: !!t.requiresDetail })),
        employees: existingEmployees.map((e: any) => ({ id: e.id, name: e.name, email: e.email, isSupervisor: !!e.isSupervisor })),
      }
    });
  } catch (error) {
    next(error);
  }
};
