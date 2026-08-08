// One-time cleanup: removes the "John Doe" test employee and sessions whose
// trainer reference(s) point at employee records that no longer exist,
// along with any checkins dangling off those sessions. Investigated first
// with scripts/inspectCleanup.ts — every affected session has either zero
// trainees or trainees that are themselves already-deleted test employees,
// so this has no effect on any real employee's credited hours.
//
// Dry run by default; pass --apply to actually delete.
import { db } from '../config/firebase';

async function main() {
  const apply = process.argv.includes('--apply');

  const employeesSnap = await db.collection('employees').get();
  const employeesById = new Map<string, any>();
  employeesSnap.docs.forEach((d) => employeesById.set(d.id, { id: d.id, ...d.data() }));

  let employeesDeleted = 0;
  let employeeSubDocsDeleted = 0;
  let sessionsDeleted = 0;
  let checkinsDeleted = 0;

  // --- John Doe test employee(s) -------------------------------------------
  const johnDoes = [...employeesById.values()].filter(
    (e: any) => (e.name || '').trim().toLowerCase() === 'john doe'
  );

  for (const emp of johnDoes) {
    const empRef = db.collection('employees').doc(emp.id);
    const trainingSessionsSnap = await empRef.collection('trainingSessions').get();
    const trainingSessionsLedSnap = await empRef.collection('trainingSessionsLed').get();

    console.log(`${apply ? 'DELETING' : 'WOULD DELETE'} employee ${emp.id} (John Doe) and ${trainingSessionsSnap.size + trainingSessionsLedSnap.size} subcollection doc(s)`);

    if (apply) {
      for (const doc of trainingSessionsSnap.docs) await doc.ref.delete();
      for (const doc of trainingSessionsLedSnap.docs) await doc.ref.delete();
      await empRef.delete();
    }
    employeeSubDocsDeleted += trainingSessionsSnap.size + trainingSessionsLedSnap.size;
    employeesDeleted++;
  }

  // --- Sessions with orphaned trainer IDs, + their dangling checkins -------
  const sessionsSnap = await db.collection('sessions').get();

  for (const doc of sessionsSnap.docs) {
    const data: any = doc.data();
    const trainerIds: string[] = Array.isArray(data.trainer) ? data.trainer : (data.trainer ? [data.trainer] : []);
    const hasOrphanedTrainer = trainerIds.some((id) => id && !employeesById.has(id));
    if (!hasOrphanedTrainer) continue;

    const checkinsSnap = await db.collection('checkins').where('sessionId', '==', doc.id).get();

    console.log(`${apply ? 'DELETING' : 'WOULD DELETE'} session ${doc.id} (${data.date} at ${data.location}, trainer=${JSON.stringify(trainerIds)}) and ${checkinsSnap.size} checkin(s)`);

    if (apply) {
      for (const checkinDoc of checkinsSnap.docs) await checkinDoc.ref.delete();
      await doc.ref.delete();
    }
    checkinsDeleted += checkinsSnap.size;
    sessionsDeleted++;
  }

  console.log('---');
  console.log(`Employees ${apply ? 'deleted' : 'that would be deleted'}: ${employeesDeleted} (+ ${employeeSubDocsDeleted} subcollection docs)`);
  console.log(`Sessions ${apply ? 'deleted' : 'that would be deleted'}: ${sessionsDeleted}`);
  console.log(`Checkins ${apply ? 'deleted' : 'that would be deleted'}: ${checkinsDeleted}`);
  console.log(apply ? 'Applied.' : 'Dry run only — pass --apply to write these changes.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
