export {};
const crypto = require('crypto');

// Verifies an HMAC signature When I Work sends on webhook requests, computed
// over the raw request body (req.rawBody — captured by the bodyParser.json
// `verify` hook in app.ts, since by the time req.body is parsed the exact
// raw bytes are gone). Fails closed: any missing/invalid signature, or a
// missing req.rawBody (which would mean the raw-body capture didn't run),
// rejects with 401 rather than silently trusting the request.
//
// TODO(verify against WIW docs): the header name ('x-wheniwork-signature')
// and signature scheme (hex-encoded HMAC-SHA256 assumed here) are
// placeholders — confirm against When I Work's actual webhook documentation
// before relying on this in production.
const SIGNATURE_HEADER = 'x-wheniwork-signature';

const getWebhookSecret = () => process.env.WHENIWORK_WEBHOOK_SECRET;

function verifyWheniworkSignature(req: any, res: any, next: any) {
  const secret = getWebhookSecret();
  if (!secret) {
    console.error('[wheniwork] WHENIWORK_WEBHOOK_SECRET is not configured — rejecting webhook');
    return res.status(401).json({ message: 'Webhook not configured' });
  }

  const signature = req.get(SIGNATURE_HEADER);
  if (!signature || !req.rawBody) {
    return res.status(401).json({ message: 'Missing or unverifiable signature' });
  }

  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');

  let signatureBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    signatureBuf = Buffer.from(signature, 'hex');
    expectedBuf = Buffer.from(expected, 'hex');
  } catch {
    return res.status(401).json({ message: 'Invalid signature' });
  }

  if (signatureBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(signatureBuf, expectedBuf)) {
    return res.status(401).json({ message: 'Invalid signature' });
  }

  next();
}

module.exports = { verifyWheniworkSignature };
