export {};
const { db } = require('../config/firebase');
const zlib = require('zlib');
const moment = require('moment');
const { generateComplianceLetter } = require('../services/complianceLetterService');

// Runs against the local Firestore emulator (see jest.setup.js). Verifies the
// generated PDF's extracted text contains the right employee/session data,
// without needing to actually open it in a PDF viewer.
describe('generateComplianceLetter', () => {
  const createdEmployeeIds: string[] = [];
  const createdSessionIds: string[] = [];

  afterEach(async () => {
    for (const id of createdSessionIds.splice(0)) await db.collection('sessions').doc(id).delete();
    for (const id of createdEmployeeIds.splice(0)) {
      const sessionsSnap = await db.collection('employees').doc(id).collection('trainingSessions').get();
      for (const doc of sessionsSnap.docs) await doc.ref.delete();
      await db.collection('employees').doc(id).delete();
    }
  });

  async function makeEmployee(overrides: Record<string, any> = {}) {
    const ref = await db.collection('employees').add({
      name: 'Jamie Rivera',
      firstName: 'Jamie',
      lastName: 'Rivera',
      email: 'jamie.rivera@example.com',
      homeLocation: 'MCAC',
      isActive: true,
      certifications: [{ type: 'Lifeguarding', expirationDate: '2099-01-01' }],
      ...overrides,
    });
    createdEmployeeIds.push(ref.id);
    return ref.id;
  }

  async function makeScheduledSession(overrides: Record<string, any> = {}) {
    const ref = await db.collection('sessions').add({
      status: 'scheduled',
      date: moment().add(3, 'days').format('YYYY-MM-DD'),
      startTime: '03:00 PM',
      length: 1,
      location: 'ERRC',
      topics: ['Inservice Training'],
      trainer: [],
      trainees: [],
      ...overrides,
    });
    createdSessionIds.push(ref.id);
    return ref.id;
  }

  // Minimal PDF text extractor tailored to pdf-lib's own output (Flate-
  // compressed content streams, text drawn as hex strings before `Tj`) — good
  // enough to verify our generated letters without a heavy PDF-parsing
  // dependency.
  function extractPdfText(buffer: Buffer): string {
    const str = buffer.toString('latin1');
    const streamRe = /(<<[^>]*?>>)\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
    const lines: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = streamRe.exec(str))) {
      const [, dict, rawContent] = m;
      let content = Buffer.from(rawContent, 'latin1');
      if (dict.includes('FlateDecode')) {
        try {
          content = zlib.inflateSync(content);
        } catch {
          continue;
        }
      }
      const cstr = content.toString('latin1');
      const tjRe = /<([0-9A-Fa-f]+)>\s*Tj/g;
      let tm: RegExpExecArray | null;
      while ((tm = tjRe.exec(cstr))) {
        lines.push(Buffer.from(tm[1], 'hex').toString('latin1'));
      }
    }
    return lines.join('\n');
  }

  it('fills in the employee name, hours missing, and upcoming sessions', async () => {
    const employeeId = await makeEmployee();
    // 1 hour logged this month -> 3.0 hours missing of the 4.0 requirement.
    await db.collection('employees').doc(employeeId).collection('trainingSessions').add({
      date: moment().startOf('month').add(2, 'days').format('YYYY-MM-DD'),
      length: 1,
      topics: ['Inservice Training'],
      trainer: [],
      location: 'MCAC',
    });
    await makeScheduledSession({ location: 'Rays Splash Planet', date: moment().add(2, 'days').format('YYYY-MM-DD') });
    await makeScheduledSession({ location: 'ERRC', date: moment().add(5, 'days').format('YYYY-MM-DD') });

    const result = await generateComplianceLetter(employeeId);

    expect(result.hoursMissing).toBe(3);
    expect(result.employeeName).toBe('Jamie Rivera');
    expect(result.employeeEmail).toBe('jamie.rivera@example.com');
    expect(result.buffer.subarray(0, 5).toString()).toBe('%PDF-');

    const text = extractPdfText(result.buffer);
    expect(text).toContain('Good Morning Jamie');
    expect(text).toContain('you are behind 3.0 Inservice hours');
    expect(text).toContain('3.0 hours by');
    expect(text).toContain('Rays Splash Planet');
    expect(text).toContain('ERRC');
  });

  it('falls back to a generic contact note when no mid-month reminder has been logged', async () => {
    const employeeId = await makeEmployee();
    const result = await generateComplianceLetter(employeeId);
    const text = extractPdfText(result.buffer);
    expect(text).toContain('Our records show you have not yet completed');
  });

  it('cites the actual date once a mid-month reminder has been logged', async () => {
    // Midday UTC so this stays on August 1st in any US timezone (this server
    // runs America/New_York) — avoids the UTC-midnight/local-date boundary
    // issue documented in utils/dateParsing.ts.
    const employeeId = await makeEmployee({ lastMidMonthNoticeSentAt: '2026-08-01T16:00:00.000Z' });
    const result = await generateComplianceLetter(employeeId);
    const text = extractPdfText(result.buffer);
    expect(text).toContain('On August 1, 2026, you were sent an email reminder');
  });

  it('shows a fallback note when fewer than 4 upcoming sessions exist', async () => {
    const employeeId = await makeEmployee();
    await makeScheduledSession();
    const result = await generateComplianceLetter(employeeId);
    const text = extractPdfText(result.buffer);
    expect(text).toContain('Additional sessions are being scheduled');
  });

  it('shows a no-sessions note when nothing is scheduled', async () => {
    const employeeId = await makeEmployee();
    const result = await generateComplianceLetter(employeeId);
    const text = extractPdfText(result.buffer);
    expect(text).toContain('No upcoming inservice sessions are currently scheduled');
  });

  it('excludes sessions dated in the past', async () => {
    const employeeId = await makeEmployee();
    await makeScheduledSession({ date: moment().subtract(5, 'days').format('YYYY-MM-DD'), location: 'Past Session Site' });
    const result = await generateComplianceLetter(employeeId);
    const text = extractPdfText(result.buffer);
    expect(text).not.toContain('Past Session Site');
  });

  it('throws a 404-flavored error for an unknown employee', async () => {
    await expect(generateComplianceLetter('does-not-exist')).rejects.toMatchObject({ statusCode: 404 });
  });
});
