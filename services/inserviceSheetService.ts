import moment from 'moment';
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from 'pdf-lib';
import { db } from '../config/firebase';
import { getSignatureBuffer } from './signatureStorage';
import { wrapText } from '../utils/pdfText';

// The 12 fixed checklist labels, normalized (trimmed, lowercased, no blank
// fill-in lines). The 13th bullet is "Other" — handled separately below.
const TOPIC_LABELS: string[] = [
  'conditioning',
  'unresponsive extrication',
  'back boarding (spinal)',
  'first aid',
  'rescue breathing',
  'cpr/aed',
  'responsive rescues',
  'unresponsive rescues',
  'submerged rescues',
  'eap',
  'scanning drills',
  'how to use lift',
];

// Display labels (title case, matching the original paper form) in the same
// order as TOPIC_LABELS above.
const TOPIC_DISPLAY_LABELS: string[] = [
  'Conditioning',
  'Unresponsive extrication',
  'Back Boarding (spinal)',
  'First Aid',
  'Rescue Breathing',
  'CPR/AED',
  'Responsive Rescues',
  'Unresponsive Rescues',
  'Submerged Rescues',
  'EAP',
  'Scanning Drills',
  'How to use lift',
];

// A session topic matches a checklist label if they're equal, or the topic
// is a shorter, more specific substring *contained in* the label (e.g. "CPR"
// matches "cpr/aed", "Back Boarding" matches "back boarding (spinal)").
// Deliberately NOT the reverse direction — a label must never match by being
// a substring of a longer topic, since "responsive rescues" is itself a
// substring of "unresponsive rescues" and would otherwise cross-mark both
// checklist items whenever only one was actually meant.
function topicMatchesLabel(topicNormalized: string, label: string): boolean {
  return topicNormalized === label || (topicNormalized.length >= 3 && label.includes(topicNormalized));
}

// Session topics are free text (no fixed enum) — this matching is a known,
// accepted best-effort limitation, not guaranteed exact.
function matchTopics(topics: string[]): { marks: boolean[]; otherText: string } {
  const normalized = (topics || []).map((t) => String(t || '').trim().toLowerCase()).filter(Boolean);
  const matchedTopicIndices = new Set<number>();

  const marks = TOPIC_LABELS.map((label) => {
    const matchIndex = normalized.findIndex((t) => topicMatchesLabel(t, label));
    if (matchIndex === -1) return false;
    matchedTopicIndices.add(matchIndex);
    return true;
  });

  const unmatched = normalized.filter((_, i) => !matchedTopicIndices.has(i));
  return { marks, otherText: unmatched.map((t) => topics[normalized.indexOf(t)] || t).join(', ') };
}

interface InserviceSheet {
  buffer: Buffer;
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Sign-in table column layout (widths sum to CONTENT_WIDTH).
const COLUMNS = [
  { label: 'Site of Employment', width: 100 },
  { label: 'Lifeguard Name', width: 140 },
  { label: 'Signature', width: 140 },
  { label: 'Time In', width: 62 },
  { label: 'Time Out', width: 62 },
];
const ROW_HEIGHT = 30;
const HEADER_ROW_HEIGHT = 20;

// Builds the org's in-service sign-in sheet as a PDF, drawn directly with
// pdf-lib — a completed session's details, checked-in employees, and their
// captured signatures, laid out to match the original paper/Word form
// (intro text, 13-item topics checklist, header fields, sign-in table).
export async function generateInserviceSheet(sessionId: string): Promise<InserviceSheet> {
  const sessionDoc = await db.collection('sessions').doc(sessionId).get();
  if (!sessionDoc.exists) {
    const err: any = new Error('Session not found');
    err.statusCode = 404;
    throw err;
  }
  const session = sessionDoc.data() as any;

  const checkinsSnap = await db.collection('checkins').where('sessionId', '==', sessionId).get();
  const checkins = checkinsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as any));

  const trainerIds: string[] = Array.isArray(session.trainer) ? session.trainer : (session.trainer ? [session.trainer] : []);
  const trainerDocs = await Promise.all(trainerIds.map((id) => db.collection('employees').doc(id).get()));
  const trainerNames = trainerDocs.map((doc, i) => (doc.exists ? (doc.data() as any).name : null) || trainerIds[i]);

  const dateLabel = session.date ? moment(session.date).format('MMMM D, YYYY') : '';
  const timeLabel = session.endTime ? `${session.startTime || ''} - ${session.endTime}` : (session.startTime || '');
  const { marks: topicMarks, otherText } = matchTopics(session.topics || []);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const ensureSpace = (needed: number) => {
    if (y - needed < MARGIN) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  };

  const writeParagraph = (text: string, { bold = false, size = 10, gapAfter = 8 } = {}) => {
    const useFont = bold ? boldFont : font;
    const lines = wrapText(useFont, text, size, CONTENT_WIDTH);
    for (const line of lines) {
      ensureSpace(size + 3);
      page.drawText(line, { x: MARGIN, y, size, font: useFont, color: rgb(0, 0, 0) });
      y -= size + 3;
    }
    y -= gapAfter;
  };

  // --- Header / instructions section (matches the original form's text) ---
  ensureSpace(20);
  page.drawText('AQUATICS IN-SERVICE FORM', { x: MARGIN, y, size: 15, font: boldFont });
  y -= 24;

  writeParagraph('Dear Aquatics Staff Members:', { bold: true, gapAfter: 4 });
  writeParagraph(
    'To ensure the safety of our members and program participants, you will be required to attend and participate in 4 hours of in-service on a monthly basis. In addition, you will be asked to sign the back of this form each in-service to indicate you have attended and participated in the required trainings.'
  );

  writeParagraph('Check the Training that was received:', { bold: true, gapAfter: 4 });
  for (let i = 0; i < TOPIC_LABELS.length; i++) {
    ensureSpace(14);
    const mark = topicMarks[i] ? '[X]' : '[ ]';
    page.drawText(`${mark} ${TOPIC_DISPLAY_LABELS[i]}`, { x: MARGIN + 8, y, size: 10, font: boldFont });
    y -= 14;
  }
  const otherMark = otherText ? '[X]' : '[ ]';
  ensureSpace(14);
  page.drawText(`${otherMark} Other: ${otherText}`, { x: MARGIN + 8, y, size: 10, font: boldFont });
  y -= 20;

  writeParagraph(
    'Failure to acquire 4 hours of in-service monthly will lead to disciplinary action, up to and including termination. If you have any questions, please contact the Aquatics Supervisor at your site, immediately.',
    { gapAfter: 16 }
  );

  // --- Sign-in sheet section ---
  ensureSpace(20);
  page.drawText('Lifeguard In-Service Sign-In Sheet', { x: MARGIN, y, size: 13, font: boldFont });
  y -= 22;

  ensureSpace(16);
  page.drawText(`Led By: ${trainerNames.join(', ')}`, { x: MARGIN, y, size: 10, font: boldFont });
  page.drawText(`Date: ${dateLabel}`, { x: MARGIN + 280, y, size: 10, font: boldFont });
  y -= 16;
  ensureSpace(16);
  page.drawText(`Time: ${timeLabel}`, { x: MARGIN, y, size: 10, font: boldFont });
  page.drawText(`Location: ${session.location || ''}`, { x: MARGIN + 280, y, size: 10, font: boldFont });
  y -= 20;

  const drawTableHeader = () => {
    ensureSpace(HEADER_ROW_HEIGHT);
    let x = MARGIN;
    page.drawRectangle({ x: MARGIN, y: y - HEADER_ROW_HEIGHT, width: CONTENT_WIDTH, height: HEADER_ROW_HEIGHT, color: rgb(0.85, 0.85, 0.85) });
    for (const col of COLUMNS) {
      page.drawText(col.label, { x: x + 4, y: y - HEADER_ROW_HEIGHT + 6, size: 9, font: boldFont });
      x += col.width;
    }
    drawRowBorders(page, y, HEADER_ROW_HEIGHT);
    y -= HEADER_ROW_HEIGHT;
  };

  drawTableHeader();

  const EMU_CAP_WIDTH = 120;
  const EMU_CAP_HEIGHT = 22;

  for (const checkin of checkins) {
    ensureSpace(ROW_HEIGHT);
    // A page break mid-table must repeat the column headers so the new
    // page's rows aren't unlabeled.
    if (y - ROW_HEIGHT < MARGIN) {
      drawTableHeader();
    }

    let x = MARGIN;
    const textY = y - ROW_HEIGHT + 10;
    page.drawText(truncateToWidth(font, checkin.location || '', 9, COLUMNS[0].width - 8), { x: x + 4, y: textY, size: 9, font });
    x += COLUMNS[0].width;
    page.drawText(truncateToWidth(font, checkin.name || '', 9, COLUMNS[1].width - 8), { x: x + 4, y: textY, size: 9, font });
    x += COLUMNS[1].width;

    if (checkin.signatureKey) {
      try {
        const sigBuffer = await getSignatureBuffer(checkin.signatureKey);
        const sigImage = await pdfDoc.embedPng(sigBuffer);
        const aspect = sigImage.width / sigImage.height;
        let cx = EMU_CAP_WIDTH;
        let cy = cx / aspect;
        if (cy > EMU_CAP_HEIGHT) {
          cy = EMU_CAP_HEIGHT;
          cx = cy * aspect;
        }
        page.drawImage(sigImage, { x: x + 4, y: y - ROW_HEIGHT + (ROW_HEIGHT - cy) / 2, width: cx, height: cy });
      } catch (error) {
        console.warn(`Failed to embed signature for checkin ${checkin.id}:`, (error as Error).message);
      }
    }
    x += COLUMNS[2].width;

    const timeIn = checkin.checkinTime ? moment(checkin.checkinTime).format('h:mm A') : '';
    const timeOut = session.closedAt ? moment(session.closedAt).format('h:mm A') : '';
    page.drawText(timeIn, { x: x + 4, y: textY, size: 9, font });
    x += COLUMNS[3].width;
    page.drawText(timeOut, { x: x + 4, y: textY, size: 9, font });

    drawRowBorders(page, y, ROW_HEIGHT);
    y -= ROW_HEIGHT;
  }

  const buffer = Buffer.from(await pdfDoc.save());
  return { buffer };
}

// Draws the grid lines (outer box + column dividers) for one table row —
// shared by the header row and every data row so the whole table lines up.
function drawRowBorders(page: PDFPage, topY: number, height: number) {
  const bottomY = topY - height;
  let x = MARGIN;
  page.drawLine({ start: { x: MARGIN, y: topY }, end: { x: MARGIN + CONTENT_WIDTH, y: topY }, thickness: 0.5, color: rgb(0, 0, 0) });
  page.drawLine({ start: { x: MARGIN, y: bottomY }, end: { x: MARGIN + CONTENT_WIDTH, y: bottomY }, thickness: 0.5, color: rgb(0, 0, 0) });
  for (const col of COLUMNS) {
    page.drawLine({ start: { x, y: topY }, end: { x, y: bottomY }, thickness: 0.5, color: rgb(0, 0, 0) });
    x += col.width;
  }
  page.drawLine({ start: { x, y: topY }, end: { x, y: bottomY }, thickness: 0.5, color: rgb(0, 0, 0) });
}

// Cells are single-line — a name/location too long for its column is
// truncated with an ellipsis rather than overflowing into the next column.
function truncateToWidth(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && font.widthOfTextAtSize(`${truncated}…`, size) > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}…`;
}
