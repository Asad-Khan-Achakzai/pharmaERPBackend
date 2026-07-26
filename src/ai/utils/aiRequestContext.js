const mongoose = require('mongoose');

/**
 * @typedef {Object} AiRequestContext
 * @property {import('mongoose').Types.ObjectId} companyId
 * @property {import('mongoose').Types.ObjectId} userId
 * @property {object} user
 * @property {string[]} permissions
 * @property {string} timeZone
 * @property {object} company
 * @property {object} clientContext
 */

function buildAiRequestContext(req, clientContext = {}) {
  const companyId = req.companyId;
  const userId = req.user?.userId;
  return {
    companyId: new mongoose.Types.ObjectId(String(companyId)),
    userId: new mongoose.Types.ObjectId(String(userId)),
    user: req.user,
    permissions: req.user?.permissions || [],
    timeZone: req.context?.timeZone || 'UTC',
    company: req.context?.company || null,
    clientContext: clientContext || {}
  };
}

module.exports = { buildAiRequestContext };
