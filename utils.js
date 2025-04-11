/**
 * Generates a unique ID using timestamp and random string
 * @returns {string} A unique ID in the format: timestamp-randomstring
 */
const generateId = () => {
  const timestamp = Date.now().toString(36); // Convert timestamp to base36
  const randomStr = Math.random().toString(36).substring(2, 15); 
  return `${timestamp}-${randomStr}`;
};

module.exports = {
  generateId
}; 