// Read-only investigation for the "orphaned trainer IDs" + "John Doe test
// users" cleanup request — reports exactly what a cleanup would touch before
// anything gets deleted. Run with: npx ts-node scripts/inspectCleanup.ts
import { db } from '../config/firebase';

async function main() {
  const employeesSnap = await db.collection('employees').get();
  const employeesById = new Map<string, any>();
  employeesSnap.docs.forEach((d) => employeesById.set(d.id, { id: d.id, ...d.data() }));

  console.log(`Total employees: ${employeesSnap.size}`);
  console.log('===================================================');

  // --- John Doe test users -------------------------------------------------
  const johnDoes = [...employeesById.values()].filter(
    (e: any) => (e.name || '').trim().toLowerCase() === 'john doe'
  );
  console.log(`\n"John Doe" employees found: ${johnDoes.length}`);
  for (const emp of johnDoes) {
    const trainingSessionsSnap = await db.collection('employees').doc(emp.id).collection('trainingSessions').get();
    const trainingSessionsLedSnap = await db.collection('employees').doc(emp.id).collection('trainingSessionsLed').get();
    const checkinsSnap = await db.collection('checkins').where('employeeId', '==', emp.id).get();
    const sessionsAsTraineeSnap = await db.collection('sessions').where('trainees', 'array-contains', emp.id).get();
    console.log(`  - ${emp.id} | active=${emp.isActive} | email=${emp.email || '(none)'} | badge=${emp.badgeNumber || '(none)'} | homeLocation=${emp.homeLocation || '(none)'} | totalHours=${emp.totalHours || 0}`);
    console.log(`      trainingSessions subcollection: ${trainingSessionsSnap.size}, trainingSessionsLed: ${trainingSessionsLedSnap.size}, checkins: ${checkinsSnap.size}, listed as trainee on sessions: ${sessionsAsTraineeSnap.size}`);
  }

  // --- Sessions with orphaned trainer IDs -----------------------------------
  const sessionsSnap = await db.collection('sessions').get();
  console.log(`\nTotal sessions: ${sessionsSnap.size}`);

  const orphaned: any[] = [];
  for (const doc of sessionsSnap.docs) {
    const data: any = doc.data();
    const trainerIds: string[] = Array.isArray(data.trainer) ? data.trainer : (data.trainer ? [data.trainer] : []);
    const missing = trainerIds.filter((id) => id && !employeesById.has(id));
    if (missing.length > 0) {
      const trainees: string[] = Array.isArray(data.trainees) ? data.trainees : [];
      const resolvedTrainees = trainees.map((id) => {
        const emp = employeesById.get(id);
        return emp ? `${emp.name} (${id})` : `MISSING(${id})`;
      });
      const checkinsSnap = await db.collection('checkins').where('sessionId', '==', doc.id).get();
      orphaned.push({
        id: doc.id,
        date: data.date,
        location: data.location,
        topics: data.topics,
        status: data.status,
        source: data.source || '(none)',
        missingTrainerIds: missing,
        allTrainerIds: trainerIds,
        traineeCount: trainees.length,
        resolvedTrainees,
        checkinCount: checkinsSnap.size,
        createdAt: data.createdAt,
      });
    }
  }

  console.log(`\nSessions with at least one orphaned (deleted-employee) trainer ID: ${orphaned.length}`);
  console.log('===================================================');
  for (const s of orphaned) {
    console.log(JSON.stringify(s, null, 2));
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
