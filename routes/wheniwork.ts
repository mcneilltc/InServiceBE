export {};
const express = require('express');
const router = express.Router();
const { verifyWheniworkSignature } = require('../middleware/verifyWheniworkSignature');
const { handleWheniworkWebhook } = require('../controllers/wheniworkController');

// No requireRole gate — When I Work calls this directly, not a logged-in
// user. Authenticity is verified via HMAC signature instead (see
// middleware/verifyWheniworkSignature.ts).
router.post('/webhook', verifyWheniworkSignature, handleWheniworkWebhook);

export default router;
