require('dotenv').config();
/**
 * Generates a unique ID using timestamp and random string
 * @returns {string} A unique ID in the format: timestamp-randomstring
 */
const generateId = () => {
  const timestamp = Date.now().toString(36); // Convert timestamp to base36
  const randomStr = Math.random().toString(36).substring(2, 15); 
  return `${timestamp}-${randomStr}`;
};

const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const verifyGoogleToken = async (idToken) => {
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    return payload; // Contains user information like email, name, etc.
  } catch (error) {
    console.error('Error verifying Google ID token:', error);
    throw new Error('Invalid Google ID token');
  }
};

module.exports = {
  generateId,
  verifyGoogleToken
}; 