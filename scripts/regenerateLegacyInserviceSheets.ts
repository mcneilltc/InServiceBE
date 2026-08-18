// One-time cleanup: sign-in sheets generated before the DOCX -> PDF rewrite
// (see inserviceSheetService.ts) still point to .docx files in R2, and
// browsers can't preview those inline (see the Sign-In Sheets page's
// isLegacyFormat handling). This regenerates each one from the session's
// current checkin data using the new PDF generator, uploads it under a new
// .pdf key (same naming convention as sessionCloseOutService.ts), repoints
// the session's inserviceSheetKey at it, and deletes the old .docx object.
//
// Run with --apply to write; without it, just reports what would happen.
//
// Pinned here (not just in app.ts) because this script runs standalone via
// ts-node, never importing app.ts — generateInserviceSheet() below formats
// absolute checkin/close-out timestamps with moment(...).format('h:mm A'),
// which is only correct if the process's local zone is actually Eastern.
// Must come before the `moment` import takes effect anywhere in this file.
process.env.TZ = 'America/New_York';

import moment from 'moment';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { db } from '../config/firebase';
import { r2Client, getBucketName } from '../config/r2';
import { generateInserviceSheet } from '../services/inserviceSheetService';

async function main() {
  const apply = process.argv.includes('--apply');

  const snap = await db.collection('sessions').where('inserviceSheetKey', '!=', null).get();
  const legacyDocs = snap.docs.filter((doc) => String(doc.data().inserviceSheetKey || '').endsWith('.docx'));

  console.log(`Found ${legacyDocs.length} session(s) with a legacy .docx sign-in sheet.`);

  let regenerated = 0;
  let failed = 0;

  for (const doc of legacyDocs) {
    const session = doc.data();
    const oldKey = session.inserviceSheetKey;
    const newKey = `inservice-sheets/${moment(session.date).format('YYYY/MM')}/${doc.id}.pdf`;

    console.log(`\n${apply ? 'REGENERATING' : 'WOULD REGENERATE'} session ${doc.id} (${session.date}, ${session.location})`);
    console.log(`  ${oldKey} -> ${newKey}`);

    // Still regenerated even with no check-in records — produces a PDF with
    // an accurate header/checklist and an empty sign-in table, which is
    // still strictly better than a legacy .docx no browser can preview.
    const checkinsSnap = await db.collection('checkins').where('sessionId', '==', doc.id).get();
    if (checkinsSnap.empty) {
      console.log(`  No check-ins found for this session — regenerating with an empty sign-in table.`);
    }

    if (!apply) continue;

    try {
      const { buffer } = await generateInserviceSheet(doc.id);
      await r2Client.send(new PutObjectCommand({
        Bucket: getBucketName(),
        Key: newKey,
        Body: buffer,
        ContentType: 'application/pdf',
      }));
      await doc.ref.update({ inserviceSheetKey: newKey });
      console.log(`  Uploaded new PDF and updated the session record.`);
      regenerated++;

      try {
        await r2Client.send(new DeleteObjectCommand({ Bucket: getBucketName(), Key: oldKey }));
        console.log(`  Deleted the old .docx object.`);
      } catch (error) {
        console.warn(`  Failed to delete the old .docx object (leaving it — the session record now points to the new PDF regardless):`, (error as Error).message);
      }
    } catch (error) {
      console.error(`  FAILED to regenerate session ${doc.id}:`, (error as Error).message);
      failed++;
    }
  }

  console.log('\n---');
  if (apply) {
    console.log(`Regenerated: ${regenerated}. Failed: ${failed}.`);
  }
  console.log(apply ? 'Applied.' : 'Dry run only — pass --apply to write these changes.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
