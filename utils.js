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

const verifyMicrosoftToken = async (accessToken) => {
  try {
    const axios = require('axios');
    const response = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return {
      email: response.data.mail || response.data.userPrincipalName,
      name: response.data.displayName || response.data.userPrincipalName,
      provider: 'microsoft',
    };
  } catch (error) {
    console.error('Error verifying Microsoft token:', error);
    throw new Error('Invalid Microsoft access token');
  }
};

const verifyYahooToken = async (accessToken) => {
  try {
    const axios = require('axios');
    const response = await axios.get('https://api.login.yahoo.com/openid/v1/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return {
      email: response.data.email,
      name: response.data.name || [response.data.given_name, response.data.family_name].filter(Boolean).join(' '),
      provider: 'yahoo',
    };
  } catch (error) {
    console.error('Error verifying Yahoo token:', error);
    throw new Error('Invalid Yahoo access token');
  }
};

module.exports = {
  generateId,
  verifyGoogleToken,
  verifyMicrosoftToken,
  verifyYahooToken
}; 