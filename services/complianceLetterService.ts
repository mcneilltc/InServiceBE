import fs from 'fs';
import path from 'path';
import moment from 'moment';
import { PDFDocument, StandardFonts, rgb, PDFFont } from 'pdf-lib';
import { db } from '../config/firebase';
import { getEmployeeHoursForMonth } from '../controllers/complianceController';
import { parseLocalDate } from '../utils/dateParsing';
import { wrapText } from '../utils/pdfText';

const MONTHLY_THRESHOLD = 4;
const MIN_SESSIONS = 4;
const MAX_SESSIONS = 10;
// How many date->today-or-later session docs to pull before filtering to
// status === 'scheduled' and taking the soonest MAX_SESSIONS — see the
// comment on getUpcomingSessions for why this exists.
const SESSIONS_QUERY_LIMIT = 50;

// The org's seal, kept from the original Word letterhead — everything else
// in that template (the "Park and Recreation Department" word-art logo) was
// a legacy WMF pdf-lib can't embed, so it's reproduced as centered styled
// text below instead, matching the original memo's centered layout (see
// the reference "Inservice Requirement Completion Documentation.docx").
const SEAL_PATH = path.join(__dirname, '..', 'templates', 'assets', 'county-seal.png');

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

interface UpcomingSession {
  date: string;
  startTime: string;
  length: number;
  location: string;
}

// Every 'scheduled' session across all sites, soonest first — the letter
// always shows company-wide opportunities, not just the employee's own site,
// per how this is meant to be used (a lifeguard can pick up inservice
// anywhere, not just their home location).
//
// Filtered by `date` range (not `status` equality) on purpose: this project
// has no firestore.indexes.json, and a `status == 'scheduled'` equality
// combined with a `date` range/orderBy needs a composite index Firestore
// won't build automatically — the query would just fail. Ranging on `date`
// alone only needs the automatic single-field index every field already
// has. It's also the fix for the actual read-cap problem: the old
// `status == 'scheduled'` query with no bound read every session ever
// scheduled (nothing ever flips old ones out of that status), once per
// letter send/download — a supervisor working through several employees in
// a row could burn hundreds of reads for 10 rows each time. Bounding by
// "today or later" is both a naturally small set for a real roster AND caps
// the read count regardless of how much stale history piles up.
async function getUpcomingSessions(): Promise<UpcomingSession[]> {
  const todayStr = moment().format('YYYY-MM-DD');
  const snap = await db.collection('sessions')
    .where('date', '>=', todayStr)
    .orderBy('date')
    .limit(SESSIONS_QUERY_LIMIT)
    .get();
  const todayStart = moment().startOf('day').toDate();

  const upcoming: (UpcomingSession & { _sortDate: Date; _sortTime: number })[] = [];
  snap.forEach((doc) => {
    const s = doc.data();
    if (s.status !== 'scheduled') return;
    const d = parseLocalDate(s.date);
    if (!d || d < todayStart) return;
    const startMoment = moment(s.startTime || '', ['hh:mm A', 'h:mm A', 'HH:mm'], true);
    upcoming.push({
      date: s.date,
      startTime: s.startTime || '',
      length: parseFloat(s.length) || 0,
      location: s.location || 'TBD',
      _sortDate: d,
      _sortTime: startMoment.isValid() ? startMoment.hours() * 60 + startMoment.minutes() : 0,
    });
  });

  upcoming.sort((a, b) => a._sortDate.getTime() - b._sortDate.getTime() || a._sortTime - b._sortTime);

  return upcoming.slice(0, MAX_SESSIONS).map(({ date, startTime, length, location }) => ({ date, startTime, length, location }));
}

function formatSessionLine(s: UpcomingSession): string {
  const dateLabel = moment(s.date).format('MMMM D, YYYY');
  const start = moment(s.startTime, ['hh:mm A', 'h:mm A', 'HH:mm'], true);
  if (!start.isValid()) {
    return `${dateLabel}, ${s.location}`;
  }
  const end = start.clone().add(s.length, 'hours');
  return `${dateLabel} – ${start.format('h:mmA')}-${end.format('h:mmA')}, ${s.location}`;
}

export interface ComplianceLetter {
  buffer: Buffer;
  hoursMissing: number;
  employeeName: string;
  employeeEmail: string;
}

// Builds the county's compliance letter as a PDF, drawn directly with
// pdf-lib (no Word template/OOXML involved) — content and wording match the
// original template exactly, just rendered natively instead of filling in
// {{TOKEN}} placeholders in a .docx.
export async function generateComplianceLetter(employeeId: string): Promise<ComplianceLetter> {
  const employeeDoc = await db.collection('employees').doc(employeeId).get();
  if (!employeeDoc.exists) {
    const err: any = new Error('Employee not found');
    err.statusCode = 404;
    throw err;
  }
  const employee = employeeDoc.data() as any;

  const monthMoment = moment();
  const hoursThisMonth = await getEmployeeHoursForMonth(
    employeeId,
    monthMoment.clone().startOf('month').toDate(),
    monthMoment.clone().endOf('month').toDate()
  );
  const hoursMissing = Math.max(0, MONTHLY_THRESHOLD - hoursThisMonth);

  const upcomingSessions = await getUpcomingSessions();
  const sessionLines = upcomingSessions.length > 0
    ? upcomingSessions.map(formatSessionLine)
    : ['No upcoming inservice sessions are currently scheduled — please contact your supervisor to arrange a time.'];
  if (upcomingSessions.length > 0 && upcomingSessions.length < MIN_SESSIONS) {
    sessionLines.push('Additional sessions are being scheduled — contact your supervisor for the latest availability.');
  }

  const contactNote = employee.lastMidMonthNoticeSentAt
    ? `On ${moment(employee.lastMidMonthNoticeSentAt).format('MMMM D, YYYY')}, you were sent an email reminder to complete your inservice hours by the end of the month. Employees who had not completed a minimum of 2 hours by the 15th were scheduled for additional inservice sessions by their supervisor.`
    : 'Our records show you have not yet completed the required inservice hours for this month.';

  const firstName = employee.firstName || (employee.name || '').split(' ')[0] || 'there';
  const todayDate = monthMoment.format('MMMM D, YYYY');
  const endOfMonthDate = monthMoment.clone().endOf('month').format('MMMM D, YYYY');
  const nextMonthNote = `Beginning ${monthMoment.clone().add(1, 'month').format('MMMM')}, the standard 4-hour monthly inservice requirement resumes. At least 2 hours must be completed by the 15th, and the full 4 hours by the end of the month.`;

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const boldFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const italicFont = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const ensureSpace = (needed: number) => {
    if (y - needed < MARGIN) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  };

  // Paragraph writer: wraps to CONTENT_WIDTH, advances y, paginates as needed.
  const writeParagraph = (text: string, { bold = false, italic = false, size = 12, gapAfter = 12, indent = 0 } = {}) => {
    const useFont = bold ? boldFont : italic ? italicFont : font;
    const lines = wrapText(useFont, text, size, CONTENT_WIDTH - indent);
    for (const line of lines) {
      ensureSpace(size + 4);
      page.drawText(line, { x: MARGIN + indent, y, size, font: useFont, color: rgb(0, 0, 0) });
      y -= size + 4;
    }
    y -= gapAfter;
  };

  const drawCentered = (text: string, useFont: PDFFont, size: number, yPos: number) => {
    const textWidth = useFont.widthOfTextAtSize(text, size);
    page.drawText(text, { x: MARGIN + (CONTENT_WIDTH - textWidth) / 2, y: yPos, size, font: useFont, color: rgb(0, 0, 0) });
    return textWidth;
  };

  // A paragraph built from differently-styled runs (bold/underline mixed
  // with regular text on the same line) — pdf-lib has no rich-text runs, so
  // this wraps word-by-word across runs and underlines are drawn manually.
  // Used for the one sentence the original memo visually emphasizes twice
  // (bold *and* underlined): the compliance deadline.
  const writeRichParagraph = (runs: { text: string; bold?: boolean; underline?: boolean }[], { size = 12, gapAfter = 12 } = {}) => {
    const words = runs.flatMap((run) =>
      run.text.split(/\s+/).filter(Boolean).map((text) => ({ text, bold: !!run.bold, underline: !!run.underline }))
    );
    const spaceWidth = font.widthOfTextAtSize(' ', size);

    let line: typeof words = [];
    let lineWidth = 0;

    const flushLine = () => {
      if (line.length === 0) return;
      ensureSpace(size + 4);
      let x = MARGIN;
      // Underline runs are drawn as one continuous line (spaces included)
      // rather than per-word, matching how Word underlines a phrase.
      let underlineStartX: number | null = null;
      for (const w of line) {
        const useFont = w.bold ? boldFont : font;
        const wWidth = useFont.widthOfTextAtSize(w.text, size);
        page.drawText(w.text, { x, y, size, font: useFont, color: rgb(0, 0, 0) });
        if (w.underline && underlineStartX === null) {
          underlineStartX = x;
        } else if (!w.underline && underlineStartX !== null) {
          page.drawLine({ start: { x: underlineStartX, y: y - 2 }, end: { x, y: y - 2 }, thickness: 0.6, color: rgb(0, 0, 0) });
          underlineStartX = null;
        }
        x += wWidth + spaceWidth;
      }
      if (underlineStartX !== null) {
        page.drawLine({ start: { x: underlineStartX, y: y - 2 }, end: { x: x - spaceWidth, y: y - 2 }, thickness: 0.6, color: rgb(0, 0, 0) });
      }
      y -= size + 4;
      line = [];
      lineWidth = 0;
    };

    for (const w of words) {
      const useFont = w.bold ? boldFont : font;
      const wWidth = useFont.widthOfTextAtSize(w.text, size);
      const extra = (line.length > 0 ? spaceWidth : 0) + wWidth;
      if (lineWidth + extra > CONTENT_WIDTH && line.length > 0) {
        flushLine();
        lineWidth = wWidth;
        line = [w];
      } else {
        lineWidth += extra;
        line.push(w);
      }
    }
    flushLine();
    y -= gapAfter;
  };

  // Letterhead: seal centered above the centered department name/memo
  // title, matching the original memo template's layout exactly.
  if (fs.existsSync(SEAL_PATH)) {
    try {
      const sealBytes = fs.readFileSync(SEAL_PATH);
      const sealImage = await pdfDoc.embedPng(sealBytes);
      const sealHeight = 65;
      const sealWidth = (sealImage.width / sealImage.height) * sealHeight;
      page.drawImage(sealImage, { x: MARGIN + (CONTENT_WIDTH - sealWidth) / 2, y: y - sealHeight, width: sealWidth, height: sealHeight });
      y -= sealHeight + 14;
    } catch {
      // Seal is decorative — a missing/unreadable asset must never block
      // sending or downloading the actual compliance content.
    }
  }

  drawCentered('MECKLENBURG COUNTY', boldFont, 18, y);
  y -= 22;
  drawCentered('Park and Recreation Department', font, 13, y);
  y -= 30;
  const memoWidth = drawCentered('MEMORANDUM', boldFont, 13, y);
  page.drawLine({
    start: { x: MARGIN + (CONTENT_WIDTH - memoWidth) / 2, y: y - 2 },
    end: { x: MARGIN + (CONTENT_WIDTH + memoWidth) / 2, y: y - 2 },
    thickness: 0.75,
    color: rgb(0, 0, 0),
  });
  y -= 28;

  writeParagraph(`Good Morning ${firstName},`, { gapAfter: 12 });
  writeParagraph(
    'The Park and Recreation Department has tried contacting you several times as it pertains to your completion of the required in services for your position as a Lifeguard with Mecklenburg County.'
  );
  writeParagraph(`As of ${todayDate} you are behind ${hoursMissing.toFixed(1)} Inservice hours.`, { bold: true });
  writeParagraph(contactNote);
  writeParagraph(
    'Mecklenburg County Lifeguards per StarGuardELITE certification policy, procedures, and standards, are required to complete and maintain a minimum of 4 hours of in-service training per month, in order to maintain a current and valid lifeguard certification. Lifeguards who do not complete their 4 hours of monthly in-service, are ineligible be on stand as a lifeguard until the in-service hours have been completed.'
  );
  writeRichParagraph([
    { text: 'In order to remain compliant with policy, you will need to complete', bold: true },
    { text: `${hoursMissing.toFixed(1)} hours by ${endOfMonthDate}.`, bold: true, underline: true },
    { text: 'I have provided you with a list of opportunities to complete the required inservices.' },
  ]);
  writeParagraph('You can complete these inservices at the following locations:', { gapAfter: 6 });

  for (const line of sessionLines) {
    ensureSpace(16);
    page.drawText('•', { x: MARGIN, y, size: 12, font });
    writeParagraph(line, { indent: 14, gapAfter: 4 });
  }
  y -= 6;

  writeParagraph(nextMonthNote, { bold: true });
  writeParagraph('If you have any questions about this schedule, please contact your supervisor.');
  writeParagraph(
    'Failure to complete the required inservices and on an ongoing basis may result in Corrective Action, up to and including dismissal as you are no longer able to eligible to perform your work duties.',
    { italic: true }
  );
  writeParagraph('Thank you for your attention to this matter.');

  const buffer = Buffer.from(await pdfDoc.save());

  return {
    buffer,
    hoursMissing,
    employeeName: employee.name || 'Employee',
    employeeEmail: employee.email || '',
  };
}
