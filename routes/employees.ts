import express from 'express';
const router = express.Router();
import validate from '../middleware/validate';
const { requireRole } = require('../middleware/requireRole');
const {
  employeeSchema,
  updateEmployeeSchema,
  bulkManualHoursPermissionSchema,
  getAllEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  bulkUpdateManualHoursPermission
} = require('../controllers/employeesController');

// Self-service lookup controller (badge + firstName/lastName or legacy name lookup)
import { lookupEmployee, getEmployeeDetailForManager } from '../controllers/employeeSelfServiceController';

// Reads — supervisors and trainers both need the employee list/detail
// (trainee pickers, OCR matching, hours tracking).
router.get('/', requireRole(['supervisor', 'trainer']), getAllEmployees);
router.get('/:id', requireRole(['supervisor', 'trainer']), getEmployeeById);

// Manager-facing detail view (compliance/hours/certs/sessions) — supervisor only,
// mirrors the self-service lookup response shape but keyed by employee ID.
router.get('/:id/detail', requireRole(['supervisor']), getEmployeeDetailForManager);

// Writes — supervisor only (Manage Employees).
router.post('/', requireRole(['supervisor']), validate(employeeSchema), createEmployee);
router.put('/:id', requireRole(['supervisor']), validate(updateEmployeeSchema), updateEmployee);
router.delete('/:id', requireRole(['supervisor']), deleteEmployee);

// Bulk toggle of canAddManualHours across many supervisors at once — the
// Manage Employees "Manual Hours Permissions" dialog, so an admin doesn't
// have to open each supervisor's edit dialog one at a time.
router.patch('/manual-hours-permissions', requireRole(['supervisor']), validate(bulkManualHoursPermissionSchema), bulkUpdateManualHoursPermission);

// Self-service lookup — public, no auth (badge-number check-in flow)
router.post('/lookup', lookupEmployee);

export default router;