// One-time migration: seed the new `sites` collection from the hardcoded
// SITES list that used to live in the frontend's constants/sites.js.
// Idempotent — skips any name that already exists as a site doc.
// Run with --apply to write; without it, just reports what would change.
import { db } from '../config/firebase';

const LEGACY_SITES = [
  'MCAC',
  'Cordelia',
  'Double Oaks',
  'Ramsey Creek Beach',
  'ERRC',
  'NRRC',
  'Rays Splash Planet',
  'Marion Diehl',
  'RTA',
];

async function main() {
  const apply = process.argv.includes('--apply');
  const existingSnapshot = await db.collection('sites').get();
  const existingNames = new Set(existingSnapshot.docs.map(d => d.data().name));

  const toCreate = LEGACY_SITES.filter(name => !existingNames.has(name));

  console.log(`Existing sites: ${existingSnapshot.size}`);
  console.log(`Sites to create: ${toCreate.length}`);
  toCreate.forEach(name => console.log(`  + ${name}`));

  if (toCreate.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (!apply) {
    console.log('\nDry run only — rerun with --apply to write.');
    return;
  }

  const batch = db.batch();
  for (const name of toCreate) {
    const ref = db.collection('sites').doc();
    batch.set(ref, { name, createdAt: new Date().toISOString() });
  }
  await batch.commit();
  console.log(`\nCreated ${toCreate.length} site(s).`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
