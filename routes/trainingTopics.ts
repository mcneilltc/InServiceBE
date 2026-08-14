import express from 'express';
import validate from '../middleware/validate';
const { requireRole } = require('../middleware/requireRole');
import { rolesAtLeast } from '../utils/roles';
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
router.get('/', requireRole(rolesAtLeast('trainer')), getAllTopics);
router.get('/:id', requireRole(rolesAtLeast('trainer')), getTopicById);

// Writes — supervisor and up (Manage Topics).
router.post('/', requireRole(rolesAtLeast('supervisor')), validate(topicSchema), createTopic);
router.put('/:id', requireRole(rolesAtLeast('supervisor')), validate(updateTopicSchema), updateTopic);
router.delete('/:id', requireRole(rolesAtLeast('supervisor')), deleteTopic);

export default router;
