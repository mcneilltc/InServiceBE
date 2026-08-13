import fs from 'fs';
import path from 'path';
import moment from 'moment';
import JSZip from 'jszip';
import sharp from 'sharp';
import { db } from '../config/firebase';
import { getSignatureBuffer } from './signatureStorage';

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'inserviceSheetTemplate.docx');

// The one repeatable sign-in row left in the template (see
// templates/inserviceSheetTemplate.docx) — duplicated once per checked-in
// employee below. Must match the template's word/document.xml exactly; if
// the template is ever re-exported from Word, re-locate this string.
const EMPLOYEE_ROW_TEMPLATE =
  '<w:tr w:rsidRPr="00812725" w:rsidR="007276A5" w:rsidTr="09A7D25A" w14:paraId="4101652C" w14:textId="77777777"><w:trPr><w:trHeight w:val="576"/></w:trPr><w:tc><w:tcPr><w:tcW w:w="1560" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="auto"/><w:vAlign w:val="center"/></w:tcPr><w:p w:rsidRPr="00812725" w:rsidR="00812725" w:rsidP="0058334A" w:rsidRDefault="00812725" w14:paraId="4B99056E" w14:textId="09DE2D3E"><w:pPr><w:rPr><w:rFonts w:eastAsia="Batang"/></w:rPr></w:pPr><w:r><w:t>{{EMP_SITE}}</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="2454" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="auto"/></w:tcPr><w:p w:rsidRPr="00812725" w:rsidR="00812725" w:rsidP="0058334A" w:rsidRDefault="00812725" w14:paraId="1299C43A" w14:textId="10ED8AD5"><w:pPr><w:rPr><w:rFonts w:eastAsia="Batang"/></w:rPr></w:pPr><w:r><w:t>{{EMP_NAME}}</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="2469" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="auto"/><w:vAlign w:val="center"/></w:tcPr><w:p w:rsidRPr="00812725" w:rsidR="00812725" w:rsidP="0058334A" w:rsidRDefault="00812725" w14:paraId="4DDBEF00" w14:textId="77777777"><w:pPr><w:rPr><w:rFonts w:eastAsia="Batang"/></w:rPr></w:pPr><w:r><w:t>{{EMP_SIGNATURE}}</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="1925" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="auto"/><w:vAlign w:val="center"/></w:tcPr><w:p w:rsidRPr="00812725" w:rsidR="00812725" w:rsidP="0058334A" w:rsidRDefault="00812725" w14:paraId="3461D779" w14:textId="77777777"><w:pPr><w:rPr><w:rFonts w:eastAsia="Batang"/></w:rPr></w:pPr><w:r><w:t>{{EMP_TIME_IN}}</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="1518" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="auto"/><w:vAlign w:val="center"/></w:tcPr><w:p w:rsidRPr="00812725" w:rsidR="00812725" w:rsidP="0058334A" w:rsidRDefault="00812725" w14:paraId="3CF2D8B6" w14:textId="77777777"><w:pPr><w:rPr><w:rFonts w:eastAsia="Batang"/></w:rPr></w:pPr><w:r><w:t>{{EMP_TIME_OUT}}</w:t></w:r></w:p></w:tc></w:tr>';

// The 12 fixed checklist labels, normalized (trimmed, lowercased, no blank
// fill-in lines), in the same order as the template's {{TOPIC_MARK_01}}..12
// tokens. The 13th bullet is "Other" — handled separately below.
const TOPIC_LABELS: string[] = [
  'conditioning',
  'unresponsive extrication',
  'back boarding (spinal)',
  'first aid',
  'rescue breathing',
  'cpr/aed',
  'responsive rescues',
  'unresponsive rescues',
  'submerged rescues',
  'eap',
  'scanning drills',
  'how to use lift',
];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// A session topic matches a checklist label if they're equal, or the topic
// is a shorter, more specific substring *contained in* the label (e.g. "CPR"
// matches "cpr/aed", "Back Boarding" matches "back boarding (spinal)").
// Deliberately NOT the reverse direction — a label must never match by being
// a substring of a longer topic, since "responsive rescues" is itself a
// substring of "unresponsive rescues" and would otherwise cross-mark both
// checklist items whenever only one was actually meant.
function topicMatchesLabel(topicNormalized: string, label: string): boolean {
  return topicNormalized === label || (topicNormalized.length >= 3 && label.includes(topicNormalized));
}

// Session topics are free text (no fixed enum) — this matching is a known,
// accepted best-effort limitation, not guaranteed exact.
function matchTopics(topics: string[]): { marks: string[]; otherText: string } {
  const normalized = (topics || []).map((t) => String(t || '').trim().toLowerCase()).filter(Boolean);
  const matchedTopicIndices = new Set<number>();

  const marks = TOPIC_LABELS.map((label) => {
    const matchIndex = normalized.findIndex((t) => topicMatchesLabel(t, label));
    if (matchIndex === -1) return '[ ] ';
    matchedTopicIndices.add(matchIndex);
    return '[X] ';
  });

  const unmatched = normalized.filter((_, i) => !matchedTopicIndices.has(i));
  return { marks, otherText: unmatched.map((t) => topics[normalized.indexOf(t)] || t).join(', ') };
}

interface InserviceSheet {
  buffer: Buffer;
}

// Fills in the org's in-service sign-in sheet template (see
// templates/inserviceSheetTemplate.docx) with a completed session's details,
// checked-in employees, and their captured signatures. Preserves the
// template's formatting exactly — only {{TOKEN}} text nodes and the
// repeatable employee row are touched, never rebuilt from scratch (same
// technique as complianceLetterService.ts).
export async function generateInserviceSheet(sessionId: string): Promise<InserviceSheet> {
  const sessionDoc = await db.collection('sessions').doc(sessionId).get();
  if (!sessionDoc.exists) {
    const err: any = new Error('Session not found');
    err.statusCode = 404;
    throw err;
  }
  const session = sessionDoc.data() as any;

  const checkinsSnap = await db.collection('checkins').where('sessionId', '==', sessionId).get();
  const checkins = checkinsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as any));

  const trainerIds: string[] = Array.isArray(session.trainer) ? session.trainer : (session.trainer ? [session.trainer] : []);
  const trainerDocs = await Promise.all(trainerIds.map((id) => db.collection('employees').doc(id).get()));
  const trainerNames = trainerDocs.map((doc, i) => (doc.exists ? (doc.data() as any).name : null) || trainerIds[i]);

  const dateLabel = session.date ? moment(session.date).format('MMMM D, YYYY') : '';
  const timeLabel = session.endTime ? `${session.startTime || ''} - ${session.endTime}` : (session.startTime || '');
  const { marks: topicMarks, otherText } = matchTopics(session.topics || []);

  const tokens: Record<string, string> = {
    '{{LED_BY}}': trainerNames.join(', '),
    '{{DATE}}': dateLabel,
    '{{TIME}}': timeLabel,
    '{{LOCATION}}': session.location || '',
    '{{OTHER_TOPICS_TEXT}}': otherText,
  };
  topicMarks.forEach((mark, i) => {
    tokens[`{{TOPIC_MARK_${String(i + 1).padStart(2, '0')}}}`] = mark;
  });
  // Bullet 13 ("Other") is marked whenever anything didn't match a fixed label.
  tokens['{{TOPIC_MARK_13}}'] = otherText ? '[X] ' : '[ ] ';

  const templateBuffer = fs.readFileSync(TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(templateBuffer);
  const documentXmlFile = zip.file('word/document.xml');
  if (!documentXmlFile) {
    throw new Error('In-service sheet template is missing word/document.xml');
  }
  let xml = await documentXmlFile.async('string');

  for (const [token, value] of Object.entries(tokens)) {
    xml = xml.split(token).join(escapeXml(value));
  }

  if (!xml.includes(EMPLOYEE_ROW_TEMPLATE)) {
    throw new Error('In-service sheet template employee-row marker not found — the template may have been re-saved from Word');
  }

  // Signatures are embedded as inline images into whichever row asks for
  // one — the trickiest part of this service, since jszip has no OOXML
  // awareness: adding an image means writing a new media part, a new
  // relationship, and a <w:drawing> fragment referencing it, all by hand.
  const relsFile = zip.file('word/_rels/document.xml.rels');
  if (!relsFile) {
    throw new Error('In-service sheet template is missing word/_rels/document.xml.rels');
  }
  let relsXml = await relsFile.async('string');

  const EMU_PER_IN = 914400;
  const MAX_CX = 1.5 * EMU_PER_IN;
  const MAX_CY = 0.4 * EMU_PER_IN;
  let signatureIndex = 0;

  const rowsXml = await Promise.all(checkins.map(async (checkin) => {
    let signatureFragment = '';
    if (checkin.signatureKey) {
      try {
        const buffer = await getSignatureBuffer(checkin.signatureKey);
        const meta = await sharp(buffer).metadata();
        const width = meta.width || 1;
        const height = meta.height || 1;
        const aspect = width / height;
        let cx = MAX_CX;
        let cy = Math.round(cx / aspect);
        if (cy > MAX_CY) {
          cy = MAX_CY;
          cx = Math.round(cy * aspect);
        }

        signatureIndex += 1;
        const n = signatureIndex;
        const mediaName = `signature_${n}.png`;
        const relId = `rIdSig${n}`;
        const docPrId = 5000 + n;

        zip.file(`word/media/${mediaName}`, buffer);
        relsXml = relsXml.replace(
          '</Relationships>',
          `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${mediaName}"/></Relationships>`
        );

        signatureFragment =
          `<w:r><w:rPr><w:noProof/></w:rPr><w:drawing>` +
          `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
          `<wp:extent cx="${cx}" cy="${cy}"/>` +
          `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
          `<wp:docPr id="${docPrId}" name="Signature${n}"/>` +
          `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
          `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
          `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
          `<pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${mediaName}"/><pic:cNvPicPr/></pic:nvPicPr>` +
          `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
          `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
          `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
          `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
      } catch (error) {
        console.warn(`Failed to embed signature for checkin ${checkin.id}:`, (error as Error).message);
        signatureFragment = '';
      }
    }

    const timeIn = checkin.checkinTime ? moment(checkin.checkinTime).format('h:mm A') : '';
    const timeOut = session.closedAt ? moment(session.closedAt).format('h:mm A') : '';

    return EMPLOYEE_ROW_TEMPLATE
      .replace('{{EMP_SITE}}', escapeXml(checkin.location || ''))
      .replace('{{EMP_NAME}}', escapeXml(checkin.name || ''))
      .replace('<w:r><w:t>{{EMP_SIGNATURE}}</w:t></w:r>', signatureFragment)
      .replace('{{EMP_TIME_IN}}', escapeXml(timeIn))
      .replace('{{EMP_TIME_OUT}}', escapeXml(timeOut));
  }));

  xml = xml.replace(EMPLOYEE_ROW_TEMPLATE, rowsXml.join(''));

  zip.file('word/document.xml', xml);
  zip.file('word/_rels/document.xml.rels', relsXml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  return { buffer };
}
