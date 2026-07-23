// One-time migration: fold the standalone `trainers` collection into
// `employees` (isTrainer + totalHoursLed fields), copying each trainer's
// trainingSessionsLed history to the matched employee doc. Session records
// that reference the old trainer IDs (or, in some historical cases, a joined
// name string) are left untouched — see the conversation this script came
// from for why that's the deliberate choice, not an oversight.
//
// Run with --apply to write; without it, just reports what would happen.
// Does NOT delete the old trainers collection — that's left for a manual,
// separate cleanup pass once you've confirmed the migrated data looks right.
import { db } from '../config/firebase';

function matchesEmail(employee: any, emailLower: string): boolean {
  if ((employee.email || '').toLowerCase() === emailLower) return true;
  const alternates: string[] = employee.alternateEmails || [];
  return alternates.some((e) => (e || '').toLowerCase() === emailLower);
}

async function main() {
  const apply = process.argv.includes('--apply');

  const [trainersSnap, employeesSnap] = await Promise.all([
    db.collection('trainers').get(),
    db.collection('employees').get(),
  ]);

  const employees = employeesSnap.docs.map((d) => ({ id: d.id, ref: d.ref, data: d.data() }));

  let matched = 0;
  let unmatched = 0;
  let sessionsLedCopied = 0;
  const unmatchedTrainers: string[] = [];

  for (const trainerDoc of trainersSnap.docs) {
    const trainer = trainerDoc.data();
    const emailLower = (trainer.email || '').toLowerCase();
    const employee = emailLower ? employees.find((e) => matchesEmail(e.data, emailLower)) : undefined;

    if (!employee) {
      unmatched++;
      unmatchedTrainers.push(`${trainerDoc.id} — ${trainer.name || '(no name)'} <${trainer.email || 'no email'}>`);
      continue;
    }

    matched++;
    const update: any = {
      isTrainer: true,
      totalHoursLed: trainer.totalHoursLed || 0,
    };
    if (!employee.data.phone && trainer.phone) {
      update.phone = trainer.phone;
    }

    console.log(`${apply ? 'UPDATING' : 'WOULD UPDATE'} employee ${employee.id} (${employee.data.name}) from trainer ${trainerDoc.id}:`, update);

    if (apply) {
      await employee.ref.update(update);
    }

    // Copy trainingSessionsLed history
    const ledSnap = await trainerDoc.ref.collection('trainingSessionsLed').get();
    for (const ledDoc of ledSnap.docs) {
      sessionsLedCopied++;
      console.log(`  ${apply ? 'COPYING' : 'WOULD COPY'} trainingSessionsLed/${ledDoc.id} -> employees/${employee.id}/trainingSessionsLed`);
      if (apply) {
        await employee.ref.collection('trainingSessionsLed').doc(ledDoc.id).set(ledDoc.data());
      }
    }
  }

  console.log('---');
  console.log(`Total trainers: ${trainersSnap.size}`);
  console.log(`Matched to an employee: ${matched}`);
  console.log(`trainingSessionsLed docs copied: ${sessionsLedCopied}`);
  console.log(`Unmatched (no employee found with that email): ${unmatched}`);
  if (unmatchedTrainers.length > 0) {
    unmatchedTrainers.forEach((line) => console.log(`  ${line}`));
  }
  console.log(apply ? 'Applied.' : 'Dry run only — pass --apply to write these changes.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
