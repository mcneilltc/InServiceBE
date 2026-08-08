const { db } = require('../config/firebase');
const { z } = require('zod');

const certificationSchema = z.object({
  type: z.string().min(1, "Certification type is required"),
  expirationDate: z.string().min(1, "Expiration date is required"),
});

// Validation Schemas
const employeeSchema = z.object({
  body: z.object({
    name: z.string({
      required_error: "Employee name is required",
    }).min(1, "Name cannot be empty"),
    email: z.string().optional(),
    alternateEmails: z.array(z.string()).optional(),
    position: z.string().optional(),
    phone: z.string().optional(),
    hireDate: z.string().optional(),
    locations: z.array(z.string()).optional(),
    homeLocation: z.string().optional(),
    certifications: z.array(certificationSchema).optional(),
    isActive: z.boolean().optional(),
    depth: z.string().nullable().optional(),
    certificationExpiration: z.string().nullable().optional(),
    hasSlideCert: z.boolean().optional(),
    hasSwimCert: z.boolean().optional(),
    isEliteSupervisor: z.boolean().optional(),
    badgeNumber: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    teamId: z.string().optional(), // Make optional if it's not strictly required by DB, adjust if needed
    isSupervisor: z.boolean().optional(),
    supervisorScope: z.enum(['all', 'locations']).optional(),
    isTrainer: z.boolean().optional(),
    // Certain supervisors are exempt from the standard 4-hour monthly
    // inservice requirement — when set, they're left out of compliance
    // tracking, alerts, and reminder emails entirely (see complianceController.ts).
    isExemptFromHoursRequirement: z.boolean().optional(),
    // Link to a When I Work user for shift sync/pickup. Intentionally NOT
    // settable here directly by callers — set only via the WIW link/backfill
    // flow (services/wheniworkService.ts), same as passwordHash below is only
    // ever set via routes/employeeAuth.ts, never the generic employee CRUD.
    wheniworkUserId: z.string().nullable().optional(),
  })
});

const updateEmployeeSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Name cannot be empty").optional(),
    email: z.string().optional(),
    alternateEmails: z.array(z.string()).optional(),
    position: z.string().optional(),
    phone: z.string().optional(),
    hireDate: z.string().optional(),
    locations: z.array(z.string()).optional(),
    homeLocation: z.string().optional(),
    certifications: z.array(certificationSchema).optional(),
    isActive: z.boolean().optional(),
    depth: z.string().nullable().optional(),
    certificationExpiration: z.string().nullable().optional(),
    hasSlideCert: z.boolean().optional(),
    hasSwimCert: z.boolean().optional(),
    isEliteSupervisor: z.boolean().optional(),
    badgeNumber: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    teamId: z.string().optional(),
    isSupervisor: z.boolean().optional(),
    supervisorScope: z.enum(['all', 'locations']).optional(),
    isTrainer: z.boolean().optional(),
    // Certain supervisors are exempt from the standard 4-hour monthly
    // inservice requirement — when set, they're left out of compliance
    // tracking, alerts, and reminder emails entirely (see complianceController.ts).
    isExemptFromHoursRequirement: z.boolean().optional(),
    wheniworkUserId: z.string().nullable().optional(),
  })
});

// Controllers
const getAllEmployees = async (req, res, next) => {
  try {
    const employeesSnapshot = await db.collection('employees').get();
    let employees = [];
    employeesSnapshot.forEach(doc => {
      employees.push({ id: doc.id, ...doc.data() });
    });

    // Location-scoped supervisors only see the roster at their own site(s);
    // 'all sites' supervisors and trainers (who need the full list for
    // trainee pickers / OCR matching) see everyone.
    const user = req.user;
    if (user && user.role === 'supervisor' && user.supervisorScope === 'locations') {
      const allowedLocations = new Set(user.supervisorLocations || []);
      employees = employees.filter(emp => (emp.locations || []).some(loc => allowedLocations.has(loc)));
    }

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
    const {
      name, email, alternateEmails, position, phone, hireDate, locations, homeLocation, certifications, isActive,
      depth, certificationExpiration, hasSlideCert, hasSwimCert,
      isEliteSupervisor, badgeNumber, firstName, lastName, teamId,
      isSupervisor, supervisorScope, isTrainer, wheniworkUserId, isExemptFromHoursRequirement
    } = req.body;

    // Prevent duplicate records — check by badge number first (the more
    // reliable real-world unique identifier), falling back to email. This
    // matches against active AND archived employees, since re-adding
    // someone who was archived should surface as "unarchive them instead",
    // not create a second record.
    const trimmedBadge = badgeNumber ? String(badgeNumber).trim() : '';
    const trimmedEmail = email ? String(email).trim() : '';
    let existingDoc = null;
    if (trimmedBadge) {
      const badgeMatch = await db.collection('employees').where('badgeNumber', '==', trimmedBadge).limit(1).get();
      if (!badgeMatch.empty) existingDoc = badgeMatch.docs[0];
    }
    if (!existingDoc && trimmedEmail) {
      const emailMatch = await db.collection('employees').where('email', '==', trimmedEmail).limit(1).get();
      if (!emailMatch.empty) existingDoc = emailMatch.docs[0];
    }
    if (existingDoc) {
      const existing = existingDoc.data();
      const matchedOn = trimmedBadge && existing.badgeNumber === trimmedBadge ? `badge #${trimmedBadge}` : `email ${trimmedEmail}`;
      const message = existing.isActive
        ? `${existing.name} already exists (matched on ${matchedOn}). Edit their existing record instead of creating a new one.`
        : `${existing.name} already exists as an archived employee (matched on ${matchedOn}). Go to the Archived Employees tab and unarchive them instead of creating a new record.`;
      // employeeId lets callers like the bulk Excel importer re-target
      // follow-up writes (e.g. historical hours) at the existing record
      // instead of just giving up on a re-run.
      return res.status(409).json({ error: { message, employeeId: existingDoc.id } });
    }

    const employeeData = {
      name,
      email: email || '',
      alternateEmails: Array.isArray(alternateEmails) ? alternateEmails : [],
      position: position || '',
      phone: phone || '',
      hireDate: hireDate || null,
      locations: Array.isArray(locations) ? locations : [],
      homeLocation: homeLocation || (Array.isArray(locations) ? locations[0] : null) || null,
      certifications: Array.isArray(certifications) ? certifications : [],
      isActive: isActive !== undefined ? isActive : true,
      archivedAt: null,
      depth: depth || null,
      certificationExpiration: certificationExpiration || null,
      hasSlideCert: !!hasSlideCert,
      hasSwimCert: !!hasSwimCert,
      isEliteSupervisor: !!isEliteSupervisor,
      badgeNumber: badgeNumber || null,
      firstName: firstName || null,
      lastName: lastName || null,
      teamId: teamId || null,
      isSupervisor: !!isSupervisor,
      supervisorScope: isSupervisor ? (supervisorScope || 'locations') : null,
      isTrainer: !!isTrainer,
      isExemptFromHoursRequirement: !!isExemptFromHoursRequirement,
      wheniworkUserId: wheniworkUserId || null,
      // Employee login (shift pickup) credentials — only ever set via
      // routes/employeeAuth.ts (invite/set-password flow), never here.
      passwordHash: null,
      passwordSetAt: null,
      totalHoursLed: 0,
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
    const {
      name, email, alternateEmails, position, phone, hireDate, locations, homeLocation, certifications, isActive,
      depth, certificationExpiration, hasSlideCert, hasSwimCert,
      isEliteSupervisor, badgeNumber, firstName, lastName, teamId,
      isSupervisor, supervisorScope, isTrainer, wheniworkUserId, isExemptFromHoursRequirement
    } = req.body;

    const docRef = db.collection('employees').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (alternateEmails !== undefined) updateData.alternateEmails = alternateEmails;
    if (position !== undefined) updateData.position = position;
    if (phone !== undefined) updateData.phone = phone;
    if (hireDate !== undefined) updateData.hireDate = hireDate;
    if (locations !== undefined) updateData.locations = locations;
    if (homeLocation !== undefined) updateData.homeLocation = homeLocation;
    if (certifications !== undefined) updateData.certifications = certifications;
    if (isActive !== undefined) {
      updateData.isActive = isActive;
      updateData.archivedAt = isActive ? null : new Date().toISOString();
    }
    if (depth !== undefined) updateData.depth = depth;
    if (certificationExpiration !== undefined) updateData.certificationExpiration = certificationExpiration;
    if (hasSlideCert !== undefined) updateData.hasSlideCert = hasSlideCert;
    if (hasSwimCert !== undefined) updateData.hasSwimCert = hasSwimCert;
    if (isEliteSupervisor !== undefined) updateData.isEliteSupervisor = isEliteSupervisor;
    if (badgeNumber !== undefined) updateData.badgeNumber = badgeNumber;
    if (firstName !== undefined) updateData.firstName = firstName;
    if (lastName !== undefined) updateData.lastName = lastName;
    if (teamId !== undefined) updateData.teamId = teamId;
    if (isSupervisor !== undefined) {
      updateData.isSupervisor = isSupervisor;
      updateData.supervisorScope = isSupervisor ? (supervisorScope || 'locations') : null;
    } else if (supervisorScope !== undefined) {
      updateData.supervisorScope = supervisorScope;
    }
    if (isTrainer !== undefined) updateData.isTrainer = isTrainer;
    if (isExemptFromHoursRequirement !== undefined) updateData.isExemptFromHoursRequirement = isExemptFromHoursRequirement;
    if (wheniworkUserId !== undefined) updateData.wheniworkUserId = wheniworkUserId;
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

    // Soft-archive instead of deleting, to preserve training session history
    await docRef.update({
      isActive: false,
      archivedAt: new Date().toISOString(),
    });

    res.json({ message: 'Employee archived' });
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
