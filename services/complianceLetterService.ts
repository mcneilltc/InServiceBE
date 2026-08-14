import fs from 'fs';
import path from 'path';
import moment from 'moment';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { db } from '../config/firebase';
import { getEmployeeHoursForMonth } from '../controllers/complianceController';
import { parseLocalDate } from '../utils/dateParsing';
import { wrapText } from '../utils/pdfText';

const MONTHLY_THRESHOLD = 4;
const MIN_SESSIONS = 4;
const MAX_SESSIONS = 10;

// The org's seal, kept from the original Word letterhead — everything else
// in that template (the "Park and Recreation Department" word-art logo) was
// a legacy WMF pdf-lib can't embed, so it's reproduced as styled text below
// instead of trying to convert that asset.
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
async function getUpcomingSessions(): Promise<UpcomingSession[]> {
  const snap = await db.collection('sessions').where('status', '==', 'scheduled').get();
  const todayStart = moment().startOf('day').toDate();

  const upcoming: (UpcomingSession & { _sortDate: Date; _sortTime: number })[] = [];
  snap.forEach((doc) => {
    const s = doc.data();
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
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const ensureSpace = (needed: number) => {
    if (y - needed < MARGIN) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  };

  // Paragraph writer: wraps to CONTENT_WIDTH, advances y, paginates as needed.
  const writeParagraph = (text: string, { bold = false, italic = false, size = 11, gapAfter = 12, indent = 0 } = {}) => {
    const useFont = bold ? boldFont : italic ? italicFont : font;
    const lines = wrapText(useFont, text, size, CONTENT_WIDTH - indent);
    for (const line of lines) {
      ensureSpace(size + 4);
      page.drawText(line, { x: MARGIN + indent, y, size, font: useFont, color: rgb(0, 0, 0) });
      y -= size + 4;
    }
    y -= gapAfter;
  };

  // Letterhead
  if (fs.existsSync(SEAL_PATH)) {
    try {
      const sealBytes = fs.readFileSync(SEAL_PATH);
      const sealImage = await pdfDoc.embedPng(sealBytes);
      const sealHeight = 50;
      const sealWidth = (sealImage.width / sealImage.height) * sealHeight;
      page.drawImage(sealImage, { x: MARGIN, y: y - sealHeight + 10, width: sealWidth, height: sealHeight });
      page.drawText('MECKLENBURG COUNTY', { x: MARGIN + sealWidth + 12, y: y - 8, size: 14, font: boldFont });
      page.drawText('Park and Recreation Department', { x: MARGIN + sealWidth + 12, y: y - 24, size: 10, font });
      y -= sealHeight + 10;
    } catch {
      // Seal is decorative — a missing/unreadable asset must never block
      // sending or downloading the actual compliance content.
    }
  } else {
    page.drawText('MECKLENBURG COUNTY', { x: MARGIN, y, size: 14, font: boldFont });
    y -= 16;
    page.drawText('Park and Recreation Department', { x: MARGIN, y, size: 10, font });
    y -= 30;
  }

  writeParagraph('MEMORANDUM', { bold: true, size: 13, gapAfter: 16 });
  writeParagraph(`Good Morning ${firstName},`, { gapAfter: 12 });
  writeParagraph(
    'The Park and Recreation Department has tried contacting you several times as it pertains to your completion of the required in services for your position as a Lifeguard with Mecklenburg County.'
  );
  writeParagraph(`As of ${todayDate} you are behind ${hoursMissing.toFixed(1)} Inservice hours.`, { bold: true });
  writeParagraph(contactNote);
  writeParagraph(
    'Mecklenburg County Lifeguards per StarGuardELITE certification policy, procedures, and standards, are required to complete and maintain a minimum of 4 hours of in-service training per month, in order to maintain a current and valid lifeguard certification. Lifeguards who do not complete their 4 hours of monthly in-service, are ineligible be on stand as a lifeguard until the in-service hours have been completed.'
  );
  writeParagraph(
    `In order to remain compliant with policy, you will need to complete ${hoursMissing.toFixed(1)} hours by ${endOfMonthDate}. I have provided you with a list of opportunities to complete the required inservices.`,
    { bold: true }
  );
  writeParagraph('You can complete these inservices at the following locations:', { gapAfter: 6 });

  for (const line of sessionLines) {
    ensureSpace(16);
    page.drawText('•', { x: MARGIN, y, size: 11, font });
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
