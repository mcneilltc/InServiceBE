import { db } from '../config/firebase';
import moment from 'moment';

// Firestore's array-contains-any accepts 1-10 values — a sign-in packet
// realistically never has more pages than that, but guard anyway.
const MAX_HASHES_PER_QUERY = 10;

export interface DuplicateSheetMatch {
  sessionId: string;
  date: string;
  location: string;
}

// Looks for an already-saved Upload Sheet session that shares at least one
// photo (by exact content hash) with the sheet currently being submitted —
// the signal that this is the same physical sign-in sheet being uploaded
// again (accidentally, or to double-dip hours), not just a similar-looking
// one. A re-photographed or re-cropped version of the same page produces a
// different hash and won't match here; this only catches the same image
// bytes coming through twice.
export async function findDuplicateSheetSession(hashes: string[]): Promise<DuplicateSheetMatch | null> {
  const trimmed = hashes.filter(Boolean).slice(0, MAX_HASHES_PER_QUERY);
  if (trimmed.length === 0) return null;

  const snap = await db.collection('sessions')
    .where('sheetImageHashes', 'array-contains-any', trimmed)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const doc = snap.docs[0];
  const data: any = doc.data();
  return { sessionId: doc.id, date: data.date, location: data.location };
}

export interface SimilarSheetMatch {
  sessionId: string;
  date: string;
  location: string;
  trainer: string[];
  topics: string[];
}

// Second layer, for the case findDuplicateSheetSession can't catch: the same
// physical sign-in sheet photographed twice (or scanned at a different
// resolution/crop), which produces different image bytes but describes the
// same real session. Flags — doesn't block — any existing Upload Sheet
// session on the same date and at the same location that also shares a
// trainer or a topic with the one being submitted, since two genuinely
// separate sessions can legitimately share all of that. A human (the
// uploader, then whoever reviews Completed Trainings) makes the actual call.
export async function findSimilarSheetSession(
  date: string,
  location: string,
  trainerIds: string[],
  topics: string[],
  excludeSessionId?: string,
): Promise<SimilarSheetMatch | null> {
  if (!date || !location) return null;

  const snap = await db.collection('sessions')
    .where('date', '==', date)
    .where('location', '==', location)
    .where('source', '==', 'upload-sheet')
    .get();

  for (const doc of snap.docs) {
    if (doc.id === excludeSessionId) continue;
    const data: any = doc.data();
    const existingTrainers: string[] = Array.isArray(data.trainer) ? data.trainer : [];
    const existingTopics: string[] = Array.isArray(data.topics) ? data.topics : [];
    const trainerOverlap = trainerIds.some((t) => t && existingTrainers.includes(t));
    const topicOverlap = topics.some((t) => t && existingTopics.includes(t));
    if (trainerOverlap || topicOverlap) {
      return { sessionId: doc.id, date: data.date, location: data.location, trainer: existingTrainers, topics: existingTopics };
    }
  }
  return null;
}

export interface OverlappingInserviceSheetMatch {
  sessionId: string;
  date: string;
  startTime: string;
  length: number;
}

// A trainer closing out (submitting an inservice sheet for) a session whose
// scheduled time overlaps one they already submitted a sheet for that same
// date would otherwise let the same time slot get double-submitted — this
// is checked before crediting any hours. Only compares against sessions that
// actually produced a sheet (inserviceSheetKey set); a zero-check-in session
// never gets one (see performCloseOut), so it can't collide here.
export async function findOverlappingInserviceSheetSession(
  trainerIds: string[],
  date: string,
  startTime: string,
  lengthHours: number,
  excludeSessionId?: string,
): Promise<OverlappingInserviceSheetMatch | null> {
  if (!date || !startTime || trainerIds.length === 0) return null;

  const timeFormats = ['YYYY-MM-DD hh:mm A', 'YYYY-MM-DD HH:mm'];
  const start = moment(`${date} ${startTime}`.trim(), timeFormats, true);
  if (!start.isValid()) return null;
  const end = start.clone().add(lengthHours || 0, 'hours');

  const snap = await db.collection('sessions').where('date', '==', date).get();

  for (const doc of snap.docs) {
    if (doc.id === excludeSessionId) continue;
    const data: any = doc.data();
    if (!data.inserviceSheetKey) continue;

    const existingTrainers: string[] = Array.isArray(data.trainer) ? data.trainer : [];
    if (!trainerIds.some((t) => t && existingTrainers.includes(t))) continue;

    const existingStart = moment(`${data.date} ${data.startTime || ''}`.trim(), timeFormats, true);
    if (!existingStart.isValid()) continue;
    const existingEnd = existingStart.clone().add(parseFloat(data.length) || 0, 'hours');

    // Standard interval-overlap test: the two ranges intersect unless one
    // ends before or exactly when the other starts.
    if (start.isBefore(existingEnd) && existingStart.isBefore(end)) {
      return { sessionId: doc.id, date: data.date, startTime: data.startTime, length: parseFloat(data.length) || 0 };
    }
  }
  return null;
}
