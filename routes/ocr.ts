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

// POST /api/ocr/extract
router.post('/extract', upload.single('sheet'), extractFromSheet);

export default router;
