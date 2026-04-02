import express from 'express';
import validate from '../middleware/validate';
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

router.get('/', getAllTrainers);
router.get('/:id', getTrainerById);
router.post('/', validate(trainerSchema), createTrainer);
router.put('/:id', validate(updateTrainerSchema), updateTrainer);
router.delete('/:id', deleteTrainer);

export default router;
