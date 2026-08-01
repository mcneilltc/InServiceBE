const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.EMAIL_FROM || 'onboarding@resend.dev';

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not configured — skipping sendEmail');
    return { ok: false, skipped: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject,
      html
    })
  });

  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: json };
}

async function sendEmailWithProvider({
  provider,
  accessToken,
  to,
  subject,
  html,
}: {
  provider: 'google' | 'microsoft' | 'yahoo' | string;
  accessToken: string;
  to: string;
  subject: string;
  html: string;
}) {
  if (!accessToken) {
    return { ok: false, skipped: true, reason: 'missing_access_token' };
  }

  if (provider === 'microsoft') {
    const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'HTML', content: html },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: true,
      }),
    });

    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: json };
  }

  if (provider === 'google') {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        raw: Buffer.from(`To: ${to}\nSubject: ${subject}\nContent-Type: text/html; charset=utf-8\n\n${html}`).toString('base64'),
      }),
    });

    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: json };
  }

  return { ok: false, skipped: true, reason: 'unsupported_provider' };
}

function midMonthEmployeeTemplate(employee: any, hours: number, upcoming: any[] = []) {
  const list = upcoming.map(s => `<li>${s.date} — ${s.topic} (${s.location || 'site'})</li>`).join('');
  return `
    <p>Hi ${employee.name || ''},</p>
    <p>You currently have <strong>${hours}</strong> hours of inservice this month.</p>
    <p>2 hours are required by the 15th and 4 by month end. Upcoming sessions at your site:</p>
    <ul>${list}</ul>
    <p>Please attend a session to meet the requirement.</p>
  `;
}

function managerMidMonthAlertTemplate(site: string, employeesZero: any[]) {
  const rows = employeesZero.map(e => `<li>${e.name} — ${e.id}</li>`).join('');
  return `
    <p><strong>${site}</strong> — ${employeesZero.length} employees have 0 inservice hours</p>
    <ul>${rows}</ul>
  `;
}

function closeOutReminderTemplate(trainerName: string, session: any) {
  const topics = (session.topics || []).join(', ') || 'the scheduled topics';
  return `
    <p>Hi ${trainerName || ''},</p>
    <p>Your training session on <strong>${session.date}</strong> at <strong>${session.location}</strong>
    (${topics}) is past its scheduled end time and hasn't been closed out yet.</p>
    <p>Please close it out in UpSkilled so attendees get credited for their hours. If it isn't closed
    out within 24 hours of the scheduled end time, it will be automatically closed using the session's
    listed duration.</p>
  `;
}

function employeeShiftLoginInviteTemplate(employee: any, setPasswordUrl: string) {
  return `
    <p>Hi ${employee.name || ''},</p>
    <p>You can now pick up available inservice shifts online. Set your password to get started:</p>
    <p><a href="${setPasswordUrl}">${setPasswordUrl}</a></p>
    <p>This link expires in 24 hours.</p>
  `;
}

export { sendEmail, sendEmailWithProvider, midMonthEmployeeTemplate, managerMidMonthAlertTemplate, closeOutReminderTemplate, employeeShiftLoginInviteTemplate };

export default { sendEmail, sendEmailWithProvider };
