import { db } from '../config/firebase';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const BCRYPT_ROUNDS = 10;
const INVITE_TOKEN_EXPIRY = '24h';
const INVITE_TOKEN_PURPOSE = 'employee-invite';

// Deliberately a separate module from services/authService.ts — that one
// resolves an already-verified SSO email to a supervisor/trainer role via a
// whitelist; this one is a distinct credential mechanism (email + password)
// for the 'employee' role, used only for shift pickup. Keeping them apart
// avoids entangling two auth mechanisms that happen to share the `employees`
// collection as their backing store.

const getInviteTokenSecret = () => process.env.EMPLOYEE_INVITE_TOKEN_SECRET;

// Case-insensitive match against the employees collection. Employee login
// isn't restricted to a supervisor/trainer subset the way SSO role
// resolution is, so this scans the full collection — same pattern already
// used elsewhere in this codebase (e.g. sessionAutomation's full-collection
// queries) and appropriate at this app's scale.
async function findEmployeeByEmail(email: string): Promise<{ id: string; data: any } | null> {
  const emailLower = email.trim().toLowerCase();
  if (!emailLower) return null;
  const snapshot = await db.collection('employees').get();
  const match = snapshot.docs.find((doc: any) => (doc.data().email || '').toLowerCase() === emailLower);
  return match ? { id: match.id, data: match.data() } : null;
}

async function verifyEmployeePassword(email: string, password: string): Promise<{ id: string; data: any } | null> {
  const found = await findEmployeeByEmail(email);
  if (!found || !found.data.passwordHash) return null;
  const matches = await bcrypt.compare(password, found.data.passwordHash);
  return matches ? found : null;
}

function createInviteToken(employeeId: string): string {
  return jwt.sign({ employeeId, purpose: INVITE_TOKEN_PURPOSE }, getInviteTokenSecret(), { expiresIn: INVITE_TOKEN_EXPIRY });
}

// Throws on an invalid/expired token, or one not issued for this purpose
// (guards against a session cookie or some other token being replayed here).
function verifyInviteToken(token: string): { employeeId: string } {
  const payload: any = jwt.verify(token, getInviteTokenSecret());
  if (payload.purpose !== INVITE_TOKEN_PURPOSE || !payload.employeeId) {
    throw new Error('Invalid invite token');
  }
  return { employeeId: payload.employeeId };
}

async function setEmployeePassword(employeeId: string, newPasswordPlaintext: string): Promise<void> {
  const passwordHash = await bcrypt.hash(newPasswordPlaintext, BCRYPT_ROUNDS);
  await db.collection('employees').doc(employeeId).update({
    passwordHash,
    passwordSetAt: new Date().toISOString(),
  });
}

export { findEmployeeByEmail, verifyEmployeePassword, createInviteToken, verifyInviteToken, setEmployeePassword };
