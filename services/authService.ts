const { db } = require('../config/firebase');

// Resolves a verified email to a role. Precedence: a supervisor (isSupervisor
// on an employee record) always wins over trainer, since supervisor access is
// a superset of trainer access.
function matchesEmail(data: any, emailLower: string): boolean {
  if ((data.email || '').toLowerCase() === emailLower) return true;
  const alternates: string[] = data.alternateEmails || [];
  return alternates.some((e) => (e || '').toLowerCase() === emailLower);
}

const resolveRole = async (email: string) => {
  const emailLower = email.toLowerCase();

  const employeesSnapshot = await db.collection('employees')
    .where('isSupervisor', '==', true)
    .get();
  const matchedSupervisor = employeesSnapshot.docs.find(
    (doc: any) => matchesEmail(doc.data(), emailLower)
  );

  if (matchedSupervisor) {
    const employee = matchedSupervisor.data();
    return {
      isWhitelisted: true,
      role: 'supervisor',
      name: employee.name || null,
      employeeId: matchedSupervisor.id,
      supervisorScope: employee.supervisorScope || 'locations',
      supervisorLocations: employee.supervisorScope === 'all' ? [] : (employee.locations || []),
      // Only false when an admin has explicitly revoked it — missing/undefined
      // (pre-existing supervisors) defaults to allowed.
      canAddManualHours: employee.canAddManualHours !== false,
    };
  }

  const trainersSnapshot = await db.collection('employees')
    .where('isTrainer', '==', true)
    .get();
  const matchedTrainer = trainersSnapshot.docs.find(
    (doc: any) => matchesEmail(doc.data(), emailLower)
  );

  if (matchedTrainer) {
    const employee = matchedTrainer.data();
    return {
      isWhitelisted: true,
      role: 'trainer',
      name: employee.name || null,
      employeeId: matchedTrainer.id,
      supervisorScope: null,
      supervisorLocations: [],
    };
  }

  return { isWhitelisted: false, role: null };
};

// A location-scoped supervisor's effective site list is derived from their
// verified session, not merely accepted from the query string — otherwise a
// scoped supervisor could widen their own request and see other sites' data.
// requestedSites === null means "no filter requested" (i.e. "all").
function clampSitesToScope(user: any, requestedSites: string[] | null): string[] | null {
  if (!user || user.role !== 'supervisor' || user.supervisorScope !== 'locations') {
    return requestedSites;
  }
  const allowed: string[] = user.supervisorLocations || [];
  if (!requestedSites) return allowed;
  return requestedSites.filter((s) => allowed.includes(s));
}

export { resolveRole, clampSitesToScope };
