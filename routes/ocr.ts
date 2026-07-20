import express from 'express';
import multer from 'multer';
import { extractFromSheet } from '../controllers/ocrController';

const router = express.Router();

// Store file in memory (buffer) — no disk writes needed
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed (JPEG, PNG, WEBP, HEIC)'));
    }
  }
});

// POST /api/ocr/extract — accepts one or more images: one or more sign-in
// sheet pages plus (usually) a separate topics-checklist page, all uploaded
// together and combined into a single Gemini call.
router.post('/extract', upload.array('sheets', 10), extractFromSheet);

export default router;
