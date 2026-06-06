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

export { sendEmail, midMonthEmployeeTemplate, managerMidMonthAlertTemplate };

export default { sendEmail };
