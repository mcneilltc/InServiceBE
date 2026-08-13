import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, getBucketName } from '../config/r2';

// A base64 data URL from the mobile check-in signature pad, e.g.
// "data:image/png;base64,iVBORw0KG...". Strips the prefix if present so a
// raw base64 string works too.
function decodeBase64Png(dataUrl: string): Buffer {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  return Buffer.from(base64, 'base64');
}

// Stores a checked-in employee's signature. Fails open (returns null on any
// error) — a lost signature shouldn't block check-in, the same posture as
// persistSheetImages in ocrController.ts.
export async function uploadSignature(sessionId: string, checkinId: string, dataUrl: string): Promise<string | null> {
  try {
    const buffer = decodeBase64Png(dataUrl);
    const key = `signatures/${sessionId}/${checkinId}.png`;
    await r2Client.send(new PutObjectCommand({
      Bucket: getBucketName(),
      Key: key,
      Body: buffer,
      ContentType: 'image/png',
    }));
    return key;
  } catch (error) {
    console.warn(`Failed to persist signature for checkin ${checkinId}:`, (error as Error).message);
    return null;
  }
}

export async function getSignatureBuffer(key: string): Promise<Buffer> {
  const result = await r2Client.send(new GetObjectCommand({ Bucket: getBucketName(), Key: key }));
  const stream = result.Body as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
