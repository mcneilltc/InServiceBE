import express from 'express';
import validate from '../middleware/validate';
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

router.get('/', getAllTopics);
router.get('/:id', getTopicById);
router.post('/', validate(topicSchema), createTopic);
router.put('/:id', validate(updateTopicSchema), updateTopic);
router.delete('/:id', deleteTopic);

export default router;
