import { Request, Response, NextFunction } from 'express';
import moment from 'moment';
import { generateComplianceLetter } from '../services/complianceLetterService';
import { sendEmail } from '../services/messagingService';

// POST /api/compliance/letter/:employeeId/send — generates the compliance
// letter from the template (see complianceLetterService.ts) and emails it to
// the employee as a PDF attachment. Supervisor-only (see routes/compliance.ts).
export const sendComplianceLetter = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const employeeId = String(req.params.employeeId);
    const { buffer, hoursMissing, employeeName, employeeEmail } = await generateComplianceLetter(employeeId);

    if (!employeeEmail) {
      return res.status(400).json({
        error: { message: `${employeeName} has no email on file — cannot send the compliance letter.` },
      });
    }

    const firstName = employeeName.split(' ')[0];
    const subject = 'Inservice Training Requirement — Action Needed';
    const html = `<p>Hi ${firstName},</p><p>Please see the attached letter regarding your inservice hour requirement for this month.</p>`;

    const result = await sendEmail(employeeEmail, subject, html, [
      { filename: `Compliance Letter - ${employeeName}.pdf`, content: buffer },
    ]);

    if (!result.ok) {
      return res.status(502).json({
        error: { message: 'Failed to send the compliance letter email.', details: result },
      });
    }

    res.json({ message: `Compliance letter sent to ${employeeName}.`, hoursMissing });
  } catch (error: any) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: { message: error.message } });
    }
    next(error);
  }
};

// GET /api/compliance/letter/:employeeId/download — generates the same
// compliance letter fresh (no R2 storage; cheap to regenerate on demand) and
// streams it back directly instead of emailing it. Supervisor-only.
export const downloadComplianceLetter = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const employeeId = String(req.params.employeeId);
    const { buffer, employeeName } = await generateComplianceLetter(employeeId);

    const filename = `Compliance_Letter_${employeeName.replace(/[^a-zA-Z0-9]+/g, '_')}_${moment().format('YYYY-MM-DD')}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error: any) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: { message: error.message } });
    }
    next(error);
  }
};
