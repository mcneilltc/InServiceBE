// One-time migration: backfill homeLocation from locations[0], and convert
// legacy single certificationExpiration into the new certifications array.
// Run with --apply to write; without it, just reports what would change.
//
// The legacy hasSlideCert/hasSwimCert/isEliteSupervisor flags are NOT
// auto-migrated — they were plain yes/no flags with no expiration date, and
// the new certifications array requires one, so there's nothing accurate to
// fabricate. Employees with those flags set are reported below so a
// supervisor can re-enter them as real certifications (with an actual
// expiration date) via Manage Employees.
import { db } from '../config/firebase';

async function main() {
  const apply = process.argv.includes('--apply');
  const snapshot = await db.collection('employees').get();

  let homeLocationBackfills = 0;
  let certMigrations = 0;
  let untouched = 0;
  const needsManualCertEntry: string[] = [];

  const batch = db.batch();
  let batchCount = 0;

  for (const doc of snapshot.docs) {
    const emp = doc.data();
    const update: any = {};

    if (!emp.homeLocation && Array.isArray(emp.locations) && emp.locations.length > 0) {
      update.homeLocation = emp.locations[0];
    }

    if (!Array.isArray(emp.certifications) || emp.certifications.length === 0) {
      if (emp.certificationExpiration) {
        update.certifications = [{ type: 'Lifeguarding', expirationDate: emp.certificationExpiration }];
      }
    }

    const legacyFlags = [
      emp.isEliteSupervisor && 'Elite Supervisor Training',
      emp.hasSwimCert && 'Swim Instructor Training',
      emp.hasSlideCert && 'Slide Certification',
    ].filter(Boolean);
    if (legacyFlags.length > 0) {
      needsManualCertEntry.push(`${doc.id} (${emp.name}): ${legacyFlags.join(', ')}`);
    }

    if (Object.keys(update).length === 0) {
      untouched++;
      continue;
    }

    if (update.homeLocation) homeLocationBackfills++;
    if (update.certifications) certMigrations++;

    console.log(`${apply ? 'UPDATING' : 'WOULD UPDATE'} ${doc.id} (${emp.name}):`, update);

    if (apply) {
      batch.update(doc.ref, update);
      batchCount++;
      if (batchCount >= 400) {
        await batch.commit();
        batchCount = 0;
      }
    }
  }

  if (apply && batchCount > 0) {
    await batch.commit();
  }

  console.log('---');
  console.log(`Total employees: ${snapshot.size}`);
  console.log(`homeLocation backfilled: ${homeLocationBackfills}`);
  console.log(`certifications migrated: ${certMigrations}`);
  console.log(`untouched (already had data or nothing to migrate): ${untouched}`);
  if (needsManualCertEntry.length > 0) {
    console.log('---');
    console.log('These employees have legacy Elite Supervisor/Swim/Slide flags set with no expiration date — re-enter them via Manage Employees:');
    needsManualCertEntry.forEach((line) => console.log(`  ${line}`));
  }
  console.log(apply ? 'Applied.' : 'Dry run only — pass --apply to write these changes.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
