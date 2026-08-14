// One-time migration: introduces the new `role` field (trainer /
// supervisor / seniorSupervisor / admin / null) alongside the legacy
// isSupervisor / isTrainer / supervisorScope / canAddManualHours /
// canManageMandatoryTopics / canDeleteSignInSheets fields — this only ADDS
// `role`, it never touches or deletes those six legacy fields, so it's safe
// to run against real Firestore before any code deploy: the
// currently-running old code keeps working off the untouched legacy fields
// the whole time. Once the new role-based code is deployed and confirmed
// stable, a separate cleanup script deletes the legacy fields.
//
// Run with --apply to write; without it, just reports what would happen.
import { db } from '../config/firebase';

// Whoever is listed here becomes 'admin' regardless of what the
// isSupervisor-derived mapping below would otherwise produce — this is the
// bootstrapping fix for the new role system: the moment new code deploys,
// role changes themselves require being admin, so at least one person must
// already be admin from this migration, not from a manual step afterward.
const SEED_ADMIN_EMAILS: string[] = ['tiquilamcneill@gmail.com'];

function matchesEmail(employee: any, emailsLower: string[]): boolean {
  const own = (employee.email || '').toLowerCase();
  if (emailsLower.includes(own)) return true;
  const alternates: string[] = employee.alternateEmails || [];
  return alternates.some((e) => emailsLower.includes((e || '').toLowerCase()));
}

function computeRole(employee: any): string | null {
  if (employee.isSupervisor) {
    return employee.supervisorScope === 'all' ? 'seniorSupervisor' : 'supervisor';
  }
  if (employee.isTrainer) {
    return 'trainer';
  }
  return null;
}

async function main() {
  const apply = process.argv.includes('--apply');

  if (apply && SEED_ADMIN_EMAILS.length === 0) {
    console.error('SEED_ADMIN_EMAILS is empty — refusing to --apply. At least one seed admin is required so someone can manage roles after this migration ships.');
    process.exit(1);
  }

  const seedAdminEmailsLower = SEED_ADMIN_EMAILS.map((e) => e.toLowerCase());
  const employeesSnap = await db.collection('employees').get();

  const counts: Record<string, number> = { admin: 0, seniorSupervisor: 0, supervisor: 0, trainer: 0, none: 0 };
  const seniorSupervisorPromotions: string[] = [];
  const seedAdminAssignments: string[] = [];

  for (const doc of employeesSnap.docs) {
    const employee = doc.data();
    let role = computeRole(employee);

    const isSeedAdmin = matchesEmail(employee, seedAdminEmailsLower);
    if (isSeedAdmin && role !== 'admin') {
      seedAdminAssignments.push(`${doc.id} — ${employee.name || '(no name)'} <${employee.email || 'no email'}> (was: ${role || 'none'})`);
      role = 'admin';
    } else if (isSeedAdmin) {
      seedAdminAssignments.push(`${doc.id} — ${employee.name || '(no name)'} <${employee.email || 'no email'}> (already mapped to admin)`);
    }

    if (role === 'seniorSupervisor' && !isSeedAdmin) {
      seniorSupervisorPromotions.push(`${doc.id} — ${employee.name || '(no name)'} <${employee.email || 'no email'}>`);
    }

    counts[role || 'none']++;

    console.log(`${apply ? 'UPDATING' : 'WOULD UPDATE'} employee ${doc.id} (${employee.name || '(no name)'}): role -> ${role === null ? 'null' : `'${role}'`}`);

    if (apply) {
      await doc.ref.update({ role });
    }
  }

  console.log('---');
  console.log(`Total employees: ${employeesSnap.size}`);
  console.log(`  admin: ${counts.admin}`);
  console.log(`  seniorSupervisor: ${counts.seniorSupervisor}`);
  console.log(`  supervisor: ${counts.supervisor}`);
  console.log(`  trainer: ${counts.trainer}`);
  console.log(`  none (roster-only, no login): ${counts.none}`);

  console.log('---');
  console.log('Auto-promoted to seniorSupervisor (previously an all-site supervisor) — gains manual-hours, mandatory-topics, and sign-in-sheet-deletion capability that may not have been individually granted before:');
  if (seniorSupervisorPromotions.length === 0) {
    console.log('  (none)');
  } else {
    seniorSupervisorPromotions.forEach((line) => console.log(`  ${line}`));
  }

  console.log('---');
  console.log('Seed admin assignment(s):');
  if (seedAdminAssignments.length === 0) {
    console.log('  (none — SEED_ADMIN_EMAILS matched no employee)');
  } else {
    seedAdminAssignments.forEach((line) => console.log(`  ${line}`));
  }

  console.log('---');
  console.log(apply ? 'Applied.' : 'Dry run only — pass --apply to write these changes.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
