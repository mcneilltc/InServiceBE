const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

// Get all employees
router.get('/', async (req, res) => {
  try {
    const employeesSnapshot = await db.collection('employees').get();
    const employees = [];
    employeesSnapshot.forEach(doc => {
      employees.push({ id: doc.id, ...doc.data() });
    });
    res.json(employees);
  } catch (error) {
    console.error('Error getting employees:', error);
    res.status(500).json({ error: 'Failed to get employees' });
  }
});

// Get a single employee by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.collection('employees').doc(id).get();
    
    if (!doc.exists) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    console.error('Error getting employee:', error);
    res.status(500).json({ error: 'Failed to get employee' });
  }
});

// Create a new employee
router.post('/', async (req, res) => {
  try {
    const { name, teamId } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Employee name is required' });
    }

    const employeeData = {
      name,
      teamId,
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
    console.error('Error adding employee:', error);
    res.status(500).json({ error: 'Failed to add employee' });
  }
});

// Update an employee
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, teamId } = req.body;

    const docRef = db.collection('employees').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const updateData = {};
    if (name) updateData.name = name;
    if (teamId) updateData.teamId = teamId;
    updateData.updatedAt = new Date().toISOString();

    await docRef.update(updateData);
    res.json({ 
      message: 'Employee updated', 
      id, 
      employee: { id, ...doc.data(), ...updateData }
    });
  } catch (error) {
    console.error('Error updating employee:', error);
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

// Delete an employee
router.delete('/:id', async (req, res) => {
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
    console.error('Error deleting employee:', error);
    res.status(500).json({ error: 'Failed to delete employee' });
  }
});

module.exports = router; 