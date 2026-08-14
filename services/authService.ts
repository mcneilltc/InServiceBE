const { db } = require('../config/firebase');
import { ROLE_HIERARCHY } from '../utils/roles';

// Resolves a verified email to a role (trainer/supervisor/seniorSupervisor/
// admin — see utils/roles.ts). Site scope is fully implied by tier now: only
// a plain 'supervisor' is location-scoped, so supervisorLocations is only
// populated for that tier; seniorSupervisor/admin are always all-site and
// trainer has no site-wide access at all.
function matchesEmail(data: any, emailLower: string): boolean {
  if ((data.email || '').toLowerCase() === emailLower) return true;
  const alternates: string[] = data.alternateEmails || [];
  return alternates.some((e) => (e || '').toLowerCase() === emailLower);
}

const resolveRole = async (email: string) => {
  const emailLower = email.toLowerCase();

  const employeesSnapshot = await db.collection('employees')
    .where('role', 'in', ROLE_HIERARCHY)
    .get();
  const matched = employeesSnapshot.docs.find(
    (doc: any) => matchesEmail(doc.data(), emailLower)
  );

  if (!matched) {
    return { isWhitelisted: false, role: null };
  }

  const employee = matched.data();
  return {
    isWhitelisted: true,
    role: employee.role,
    name: employee.name || null,
    employeeId: matched.id,
    supervisorLocations: employee.role === 'supervisor' ? (employee.locations || []) : [],
  };
};

// A location-scoped supervisor's effective site list is derived from their
// verified session, not merely accepted from the query string — otherwise a
// scoped supervisor could widen their own request and see other sites' data.
// requestedSites === null means "no filter requested" (i.e. "all"). Every
// other tier (seniorSupervisor, admin) is all-site by definition, and
// trainer has no site-wide data access to begin with, so only 'supervisor'
// needs clamping.
function clampSitesToScope(user: any, requestedSites: string[] | null): string[] | null {
  if (!user || user.role !== 'supervisor') {
    return requestedSites;
  }
  const allowed: string[] = user.supervisorLocations || [];
  if (!requestedSites) return allowed;
  return requestedSites.filter((s) => allowed.includes(s));
}

export { resolveRole, clampSitesToScope };
