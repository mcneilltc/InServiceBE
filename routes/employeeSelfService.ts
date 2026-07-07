import express from 'express';
import { lookupEmployee } from '../controllers/employeeSelfServiceController';

const router = express.Router();

// POST /api/employee/lookup
router.post('/lookup', lookupEmployee);

export default router;
