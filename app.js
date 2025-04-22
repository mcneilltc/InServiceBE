
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = 5001; // Or any other port

app.use(cors());
app.use(bodyParser.json());

// Import your API routes here (will be created in the next steps)
const employeeRoutes = require('./routes/employees');
const trainingSessionRoutes = require('./routes/trainingSessions');
const trainingTopicRoutes = require('./routes/trainingTopics');
const trainerRoutes = require('./routes/trainers');
const dashboardRoutes = require('./routes/dashboard');

app.use('/api/employees', employeeRoutes);
app.use('/api/training-sessions', trainingSessionRoutes);
app.use('/api/training-topics', trainingTopicRoutes);
app.use('/api/trainers', trainerRoutes);
app.use('/api/dashboard', dashboardRoutes);

app.get('/', (req, res) => {
  res.send('Training Management Application Backend is running!');
});

// Only start the server if this file is run directly
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;