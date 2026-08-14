import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Cloudflare R2 speaks the S3 API, so the AWS SDK works against it unmodified —
// just point endpoint at the account-scoped R2 URL and use R2 API token creds.
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
});

const getBucketName = () => {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error('R2_BUCKET_NAME is not configured');
  return bucket;
};

// 5 minutes is enough for a page load plus a slow connection, short enough
// that a leaked/cached link stops working well before it could be reused.
const SIGNED_URL_EXPIRY_SECONDS = 5 * 60;

// `downloadFilename` sets Content-Disposition on the signed URL so the
// browser saves the file under a clean name instead of the raw R2 key.
async function getSignedSheetImageUrl(key: string, downloadFilename?: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    ...(downloadFilename ? { ResponseContentDisposition: `attachment; filename="${downloadFilename}"` } : {}),
  });
  return getSignedUrl(r2Client, command, { expiresIn: SIGNED_URL_EXPIRY_SECONDS });
}

export { r2Client, getBucketName, getSignedSheetImageUrl };
