import fs from 'fs';
import path from 'path';
import moment from 'moment';
import JSZip from 'jszip';
import { db } from '../config/firebase';
import { getEmployeeHoursForMonth } from '../controllers/complianceController';
import { parseLocalDate } from '../utils/dateParsing';

const MONTHLY_THRESHOLD = 4;
const MIN_SESSIONS = 4;
const MAX_SESSIONS = 10;
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'complianceLetterTemplate.docx');

// The one repeatable bullet paragraph left in the template (see
// templates/complianceLetterTemplate.docx) — duplicated once per upcoming
// session below. Must match the template's word/document.xml exactly; if
// the template is ever re-exported from Word, re-locate this string.
const SESSION_ITEM_TEMPLATE =
  '<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="14"/></w:numPr>' +
  '<w:rPr><w:rFonts w:eastAsiaTheme="minorEastAsia"/><w:noProof/></w:rPr></w:pPr>' +
  '<w:r><w:rPr><w:rFonts w:eastAsiaTheme="minorEastAsia"/><w:noProof/></w:rPr><w:t>{{SESSION_ITEM}}</w:t></w:r></w:p>';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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

// Fills in the county's compliance-letter template (see
// templates/complianceLetterTemplate.docx) with this employee's current
// hours-missing figure and the next upcoming inservice opportunities
// company-wide. The template's letterhead/formatting is preserved exactly —
// only the {{TOKEN}} text nodes and the repeatable session bullet are
// touched, never rebuilt from scratch.
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

  const tokens: Record<string, string> = {
    '{{FIRST_NAME}}': firstName,
    '{{TODAY_DATE}}': monthMoment.format('MMMM D, YYYY'),
    '{{HOURS_MISSING}}': hoursMissing.toFixed(1),
    '{{END_OF_MONTH_DATE}}': monthMoment.clone().endOf('month').format('MMMM D, YYYY'),
    '{{CONTACT_NOTE}}': contactNote,
    '{{NEXT_MONTH_NOTE}}': `Beginning ${monthMoment.clone().add(1, 'month').format('MMMM')}, the standard 4-hour monthly inservice requirement resumes. At least 2 hours must be completed by the 15th, and the full 4 hours by the end of the month.`,
  };

  const templateBuffer = fs.readFileSync(TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(templateBuffer);
  const documentXmlFile = zip.file('word/document.xml');
  if (!documentXmlFile) {
    throw new Error('Compliance letter template is missing word/document.xml');
  }
  let xml = await documentXmlFile.async('string');

  for (const [token, value] of Object.entries(tokens)) {
    xml = xml.split(token).join(escapeXml(value));
  }

  if (!xml.includes(SESSION_ITEM_TEMPLATE)) {
    throw new Error('Compliance letter template session-item marker not found — the template may have been re-saved from Word');
  }
  const sessionParagraphsXml = sessionLines
    .map((line) => SESSION_ITEM_TEMPLATE.replace('{{SESSION_ITEM}}', escapeXml(line)))
    .join('');
  xml = xml.replace(SESSION_ITEM_TEMPLATE, sessionParagraphsXml);

  zip.file('word/document.xml', xml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  return {
    buffer,
    hoursMissing,
    employeeName: employee.name || 'Employee',
    employeeEmail: employee.email || '',
  };
}
