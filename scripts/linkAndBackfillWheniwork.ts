// One-time (re-runnable) setup script for the When I Work integration.
// Modeled on scripts/migrateSitesToFirestore.ts: idempotent, dry-run by
// default, plain console.log reporting, run with `--apply` to write.
//
// Step A: link existing employees to their When I Work user by email.
// Step B: pull every currently-open WIW shift and upsert it locally, since
//         webhooks (routes/wheniwork.ts) only cover *future* changes — this
//         is the only way already-existing open shifts get in at cutover.
//         Reuses upsertShiftFromWebhookEvent so backfill and live sync share
//         one code path.
import { db } from '../config/firebase';
import { getUserByEmail, listOpenShifts } from '../services/wheniworkClient';
import { upsertShiftFromWebhookEvent } from '../services/wheniworkService';

async function linkEmployees(apply: boolean) {
  const snapshot = await db.collection('employees').get();
  const unlinked = snapshot.docs.filter((doc) => {
    const data = doc.data();
    return data.email && !data.wheniworkUserId;
  });

  console.log(`\n=== Step A: link employees to When I Work users ===`);
  console.log(`Employees with an email and no wheniworkUserId: ${unlinked.length}`);

  let linked = 0;
  const unmatched: string[] = [];

  for (const doc of unlinked) {
    const employee = doc.data();
    try {
      const wiwUser = await getUserByEmail(employee.email);
      const wheniworkUserId = wiwUser?.id ?? wiwUser?.data?.[0]?.id ?? null;
      if (!wheniworkUserId) {
        unmatched.push(`${employee.name} <${employee.email}>`);
        continue;
      }

      console.log(`  ${apply ? '+' : '(would link)'} ${employee.name} <${employee.email}> -> WIW user ${wheniworkUserId}`);
      if (apply) {
        await doc.ref.update({ wheniworkUserId: String(wheniworkUserId), updatedAt: new Date().toISOString() });
      }
      linked++;
    } catch (err: any) {
      console.error(`  ! Failed to look up ${employee.email}:`, err.message);
      unmatched.push(`${employee.name} <${employee.email}> (lookup error)`);
    }
  }

  console.log(`Linked: ${linked}`);
  if (unmatched.length) {
    console.log(`Unmatched (needs manual review): ${unmatched.length}`);
    unmatched.forEach((line) => console.log(`  - ${line}`));
  }
}

async function backfillOpenShifts(apply: boolean) {
  console.log(`\n=== Step B: backfill currently-open When I Work shifts ===`);
  const openShifts = await listOpenShifts();
  const shiftList = Array.isArray(openShifts) ? openShifts : openShifts?.data || [];
  console.log(`Open shifts fetched from When I Work: ${shiftList.length}`);

  if (!apply) {
    console.log('Dry run — would upsert each of the above into the local `shifts` collection.');
    return;
  }

  let upserted = 0;
  for (const shift of shiftList) {
    await upsertShiftFromWebhookEvent('shift.backfill', shift);
    upserted++;
  }
  console.log(`Upserted: ${upserted}`);
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? 'Running with --apply (will write).' : 'Dry run only — rerun with --apply to write.');

  await linkEmployees(apply);
  await backfillOpenShifts(apply);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
