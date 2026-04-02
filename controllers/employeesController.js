const { db } = require('../config/firebase');
const { z } = require('zod');

// Validation Schemas
const employeeSchema = z.object({
  body: z.object({
    name: z.string({
      required_error: "Employee name is required",
    }).min(1, "Name cannot be empty"),
    teamId: z.string().optional() // Make optional if it's not strictly required by DB, adjust if needed
  })
});

const updateEmployeeSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Name cannot be empty").optional(),
    teamId: z.string().optional()
  })
});

// Controllers
const getAllEmployees = async (req, res, next) => {
  try {
    const employeesSnapshot = await db.collection('employees').get();
    const employees = [];
    employeesSnapshot.forEach(doc => {
      employees.push({ id: doc.id, ...doc.data() });
    });
    res.json(employees);
  } catch (error) {
    next(error); // Pass error to global error handler
  }
};

const getEmployeeById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const doc = await db.collection('employees').doc(id).get();
    
    if (!doc.exists) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    next(error);
  }
};

const createEmployee = async (req, res, next) => {
  try {
    const { name, teamId } = req.body;
    
    const employeeData = {
      name,
      teamId: teamId || null,
      totalHours: 0,
      createdAt: new Date().toISOString()
    };

    const docRef = await db.collection('employees').add(employeeData);
    res.status(201).json({ 
      message: 'Employee added', 
      id: docRef.id, 
      employee: { id: docRef.id, ...employeeData }
    });
  } catch (error) {
    next(error);
  }
};

const updateEmployee = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, teamId } = req.body;

    const docRef = db.collection('employees').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (teamId !== undefined) updateData.teamId = teamId;
    updateData.updatedAt = new Date().toISOString();

    await docRef.update(updateData);
    res.json({ 
      message: 'Employee updated', 
      id, 
      employee: { id, ...doc.data(), ...updateData }
    });
  } catch (error) {
    next(error);
  }
};

const deleteEmployee = async (req, res, next) => {
  try {
    const { id } = req.params;
    const docRef = db.collection('employees').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Delete all training sessions for this employee
    const sessionsSnapshot = await docRef.collection('trainingSessions').get();
    const deletePromises = sessionsSnapshot.docs.map(doc => doc.ref.delete());
    await Promise.all(deletePromises);

    // Delete the employee
    await docRef.delete();
    res.json({ message: 'Employee deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  employeeSchema,
  updateEmployeeSchema,
  getAllEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deleteEmployee
};
