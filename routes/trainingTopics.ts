import express from 'express';
import validate from '../middleware/validate';
const { requireRole } = require('../middleware/requireRole');
import {
  topicSchema,
  updateTopicSchema,
  getAllTopics,
  getTopicById,
  createTopic,
  updateTopic,
  deleteTopic
} from '../controllers/trainingTopicsController';

const router = express.Router();

// Reads — supervisors and trainers both need the topic list (session pickers).
router.get('/', requireRole(['supervisor', 'trainer']), getAllTopics);
router.get('/:id', requireRole(['supervisor', 'trainer']), getTopicById);

// Writes — supervisor only (Manage Topics).
router.post('/', requireRole(['supervisor']), validate(topicSchema), createTopic);
router.put('/:id', requireRole(['supervisor']), validate(updateTopicSchema), updateTopic);
router.delete('/:id', requireRole(['supervisor']), deleteTopic);

export default router;
