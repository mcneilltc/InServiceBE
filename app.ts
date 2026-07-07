
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const port = 5001; // Or any other port

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true })); // Parse URL-encoded bodies

// Import your API routes here (will be created in the next steps)
import employeeRoutes from './routes/employees';
import trainingSessionRoutes from './routes/trainingSessions';
import trainingTopicRoutes from './routes/trainingTopics';
import trainerRoutes from './routes/trainers';
import dashboardRoutes from './routes/dashboard';
import checkinRoutes from './routes/checkin';
import sessionRoutes from './routes/sessions';

import reportRoutes from './routes/reports';
import adminRoutes from './routes/admin';
import ocrRoutes from './routes/ocr';
import complianceRoutes from './routes/compliance';
import employeeSelfServiceRoutes from './routes/employeeSelfService';

app.use('/api/employees', employeeRoutes);
app.use('/api/training-sessions', trainingSessionRoutes);
app.use('/api/training-topics', trainingTopicRoutes);
app.use('/api/trainers', trainerRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/checkin', checkinRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ocr', ocrRoutes);
app.use('/api/compliance', complianceRoutes);
app.use('/api/employee', employeeSelfServiceRoutes);

const { verifyGoogleToken, verifyMicrosoftToken } = require('./utils');

// Google Sign-In verification route
app.post('/api/google-signin', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ message: 'ID token is required' });
    }

    const userData = await verifyGoogleToken(idToken);
    res.json({ message: 'Google Sign-In successful', user: userData });
  } catch (error) {
    res.status(401).json({ error: 'Google Sign-In failed', details: error.message });
  }
});

// Microsoft Sign-In verification route
app.post('/api/microsoft-signin', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) {
      return res.status(400).json({ message: 'Access token is required' });
    }

    const userData = await verifyMicrosoftToken(accessToken);
    res.json({ message: 'Microsoft Sign-In successful', user: userData });
  } catch (error) {
    res.status(401).json({ error: 'Microsoft Sign-In failed', details: error.message });
  }
});

app.get('/', (req, res) => {
  res.send('Training Management Application Backend is running!');
});

// Error Handling Middleware (must be exactly after all routes)
app.use(errorHandler);

// Only start the server if this file is run directly
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

export default app;