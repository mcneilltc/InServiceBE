import { Request, Response, NextFunction } from 'express';
import { db } from '../config/firebase';
import jwt from 'jsonwebtoken';
import moment from 'moment';

const QR_SECRET = process.env.QR_SIGNING_SECRET || process.env.QR_SECRET || 'change-this';

// POST /api/checkin/self
export const selfCheckin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, badgeNumber, firstName, lastName } = req.body;
    if (!token || !badgeNumber || !firstName || !lastName) {
      return res.status(400).json({ message: 'token, badgeNumber, firstName and lastName are required' });
    }

    let payload: any;
    try {
      payload = jwt.verify(token, QR_SECRET);
    } catch (err) {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }

    const { sessionId, exp } = payload;
    if (!sessionId) return res.status(400).json({ message: 'Token missing sessionId' });

    // Optional: check exp if present
    if (exp && typeof exp === 'number' && Date.now() / 1000 > exp) {
      return res.status(401).json({ message: 'Token expired' });
    }

    // Find employee by badge
    const badgeTrim = String(badgeNumber).trim();
    const empSnap = await db.collection('employees').where('badgeNumber', '==', badgeTrim).get();
    if (empSnap.empty) return res.status(404).json({ message: 'Employee not found' });

    // Match name (first + last) against stored record(s)
    const providedFirst = String(firstName).trim().toLowerCase();
    const providedLast = String(lastName).trim().toLowerCase();

    let matchedEmp: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (const doc of empSnap.docs) {
      const d = doc.data();
      const storedFirst = (d.firstName || '').toLowerCase();
      const storedLast = (d.lastName || '').toLowerCase();
      const [legacyFirst = '', ...legacyLastParts] = (d.name || '').toLowerCase().split(' ');
      const legacyLast = legacyLastParts.join(' ');
      const firstMatch = storedFirst === providedFirst || legacyFirst === providedFirst;
      const lastMatch = storedLast === providedLast || legacyLast === providedLast;
      if (firstMatch && lastMatch) {
        matchedEmp = doc;
        break;
      }
    }

    if (!matchedEmp) return res.status(403).json({ message: 'Badge and name do not match' });

    const employeeId = matchedEmp.id;
    const employeeData = matchedEmp.data();

    // Duplicate check: same employeeId + same sessionId
    const dupQuery = await db.collection('checkins')
      .where('sessionId', '==', sessionId)
      .where('employeeId', '==', employeeId)
      .get();
    if (!dupQuery.empty) {
      const existing = dupQuery.docs[0].data();
      return res.status(409).json({ message: 'Already checked in for this session', existing });
    }

    // Save check-in
    const checkinData = {
      sessionId,
      employeeId,
      badgeNumber: badgeTrim,
      name: `${employeeData.firstName || ''} ${employeeData.lastName || ''}`.trim(),
      checkinTime: new Date().toISOString(),
    };

    const docRef = await db.collection('checkins').add(checkinData);

    // Fetch session details for confirmation
    const sessionDoc = await db.collection('sessions').doc(sessionId).get();
    const sessionData = sessionDoc.exists ? sessionDoc.data() : null;

    res.status(200).json({ id: docRef.id, checkin: checkinData, session: sessionData });
  } catch (error) {
    next(error);
  }
};

export default { selfCheckin };
