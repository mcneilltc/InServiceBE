import express from 'express';
const router = express.Router();
import validate from '../middleware/validate';
const { requireRole } = require('../middleware/requireRole');
import { rolesAtLeast } from '../utils/roles';
const {
  employeeSchema,
  updateEmployeeSchema,
  getAllEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deleteEmployee,
} = require('../controllers/employeesController');

// Self-service lookup controller (badge + firstName/lastName or legacy name lookup)
import { lookupEmployee, getEmployeeDetailForManager } from '../controllers/employeeSelfServiceController';

// Reads — supervisors and trainers both need the employee list/detail
// (trainee pickers, OCR matching, hours tracking).
router.get('/', requireRole(rolesAtLeast('trainer')), getAllEmployees);
router.get('/:id', requireRole(rolesAtLeast('trainer')), getEmployeeById);

// Manager-facing detail view (compliance/hours/certs/sessions) — supervisor only,
// mirrors the self-service lookup response shape but keyed by employee ID.
router.get('/:id/detail', requireRole(rolesAtLeast('supervisor')), getEmployeeDetailForManager);

// Writes — supervisor and up (Manage Employees). Changing the `role` field
// itself is further restricted to admin — see updateEmployee's live check.
router.post('/', requireRole(rolesAtLeast('supervisor')), validate(employeeSchema), createEmployee);
router.put('/:id', requireRole(rolesAtLeast('supervisor')), validate(updateEmployeeSchema), updateEmployee);
router.delete('/:id', requireRole(rolesAtLeast('supervisor')), deleteEmployee);

// Self-service lookup — public, no auth (badge-number check-in flow)
router.post('/lookup', lookupEmployee);

export default router;