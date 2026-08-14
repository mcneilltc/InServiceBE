export {};
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { db } = require('../config/firebase');
const { COOKIE_OPTIONS, SESSION_MAX_AGE_SECONDS, requireRole } = require('../middleware/requireRole');
import { rolesAtLeast } from '../utils/roles';
const {
  findEmployeeByEmail,
  verifyEmployeePassword,
  createInviteToken,
  verifyInviteToken,
  setEmployeePassword,
} = require('../services/employeeAuthService');
const { sendEmail, employeeShiftLoginInviteTemplate } = require('../services/messagingService');

const getSessionSecret = () => process.env.SESSION_SECRET;
const getFrontendUrl = () => process.env.FRONTEND_URL || 'http://localhost:3000';

// POST /api/auth/employee/login — body: { email, password }. Public. Mirrors
// completeLogin()'s cookie-issuing shape in routes/auth.ts, reusing the same
// COOKIE_OPTIONS/SESSION_SECRET — this is a pure extension of the existing
// session mechanism, not a second cookie/session system.
router.post('/login', async (req: any, res: any) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: 'email and password are required' });
    }

    const found = await findEmployeeByEmail(email);
    if (!found) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    if (found.data.isActive === false) {
      return res.status(403).json({ message: 'This account is inactive. Contact your supervisor.' });
    }
    if (!found.data.passwordHash) {
      return res.status(401).json({ message: 'No password set for this account yet. Ask your supervisor for an invite.' });
    }

    const matched = await verifyEmployeePassword(email, password);
    if (!matched) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const claims = {
      email: found.data.email,
      name: found.data.name || null,
      role: 'employee',
      employeeId: found.id,
      wheniworkUserId: found.data.wheniworkUserId || null,
      provider: 'password',
      accessToken: null,
    };

    const token = jwt.sign(claims, getSessionSecret(), { expiresIn: SESSION_MAX_AGE_SECONDS });
    res.cookie('session', token, COOKIE_OPTIONS);
    res.json({ user: claims });
  } catch (error: any) {
    console.error('Employee login failed:', error);
    res.status(500).json({ message: 'Login failed' });
  }
});

// POST /api/auth/employee/invite — supervisor-triggered. body: { employeeId }
router.post('/invite', requireRole(rolesAtLeast('supervisor')), async (req: any, res: any) => {
  try {
    const { employeeId } = req.body || {};
    if (!employeeId) {
      return res.status(400).json({ message: 'employeeId is required' });
    }

    const doc = await db.collection('employees').doc(employeeId).get();
    if (!doc.exists) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    const employee = doc.data();
    if (!employee.email) {
      return res.status(400).json({ message: 'This employee has no email on file — add one in Manage Employees first.' });
    }

    const token = createInviteToken(employeeId);
    const setPasswordUrl = `${getFrontendUrl()}/employee-set-password?token=${encodeURIComponent(token)}`;
    const html = employeeShiftLoginInviteTemplate(employee, setPasswordUrl);
    const result = await sendEmail(employee.email, 'Set up your shift pickup login', html);

    res.json({ message: 'Invite sent', result });
  } catch (error: any) {
    console.error('Employee invite failed:', error);
    res.status(500).json({ message: 'Failed to send invite' });
  }
});

// POST /api/auth/employee/set-password — public, token-gated. body: { token, password }
router.post('/set-password', async (req: any, res: any) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ message: 'token and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    let payload: { employeeId: string };
    try {
      payload = verifyInviteToken(token);
    } catch {
      return res.status(401).json({ message: 'This invite link is invalid or has expired.' });
    }

    await setEmployeePassword(payload.employeeId, password);
    res.json({ message: 'Password set — you can now log in.' });
  } catch (error: any) {
    console.error('Employee set-password failed:', error);
    res.status(500).json({ message: 'Failed to set password' });
  }
});

// POST /api/auth/employee/change-password — requires an existing employee session.
router.post('/change-password', requireRole(['employee']), async (req: any, res: any) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    const employeeId = req.user.employeeId;
    const doc = await db.collection('employees').doc(employeeId).get();
    if (!doc.exists || !doc.data().passwordHash) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const matches = await bcrypt.compare(currentPassword, doc.data().passwordHash);
    if (!matches) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    await setEmployeePassword(employeeId, newPassword);
    res.json({ message: 'Password changed' });
  } catch (error: any) {
    console.error('Employee change-password failed:', error);
    res.status(500).json({ message: 'Failed to change password' });
  }
});

export default router;
