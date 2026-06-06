import express from 'express';
const router = express.Router();
import validate from '../middleware/validate';
const { 
  employeeSchema, 
  updateEmployeeSchema, 
  getAllEmployees, 
  getEmployeeById, 
  createEmployee, 
  updateEmployee, 
  deleteEmployee 
} = require('../controllers/employeesController');

// Self-service lookup controller (badge + firstName/lastName or legacy name lookup)
import { lookupEmployee } from '../controllers/employeeSelfServiceController';

// Get all employees
router.get('/', getAllEmployees);

// Get a single employee by ID
router.get('/:id', getEmployeeById);

// Create a new employee
router.post('/', validate(employeeSchema), createEmployee);

// Self-service lookup (no auth required)
router.post('/lookup', lookupEmployee);

// Update an employee
router.put('/:id', validate(updateEmployeeSchema), updateEmployee);

// Delete an employee
router.delete('/:id', deleteEmployee);

export default router;