import express from 'express';
import validate from '../middleware/validate';
const { requireRole } = require('../middleware/requireRole');
import {
  trainerSchema,
  updateTrainerSchema,
  getAllTrainers,
  getTrainerById,
  createTrainer,
  updateTrainer,
  deleteTrainer
} from '../controllers/trainersController';

const router = express.Router();

// Reads — supervisors and trainers both need the trainer list (session/report pickers).
router.get('/', requireRole(['supervisor', 'trainer']), getAllTrainers);
router.get('/:id', requireRole(['supervisor', 'trainer']), getTrainerById);

// Writes — supervisor only (Manage Trainers).
router.post('/', requireRole(['supervisor']), validate(trainerSchema), createTrainer);
router.put('/:id', requireRole(['supervisor']), validate(updateTrainerSchema), updateTrainer);
router.delete('/:id', requireRole(['supervisor']), deleteTrainer);

export default router;
