const ApiError = require('../../utils/ApiError');
const aiEnv = require('../config/aiEnv');
const { resolveAiCopilotEnabled } = require('../services/aiSettings.service');

function requireAiCopilot() {
  return (req, _res, next) => {
    try {
      if (!aiEnv.globalEnabled) {
        const err = new ApiError(503, 'AI Copilot is temporarily disabled.');
        err.code = 'AI_COPILOT_DISABLED';
        throw err;
      }
      const company = req.context?.company;
      if (!company) {
        return next(new ApiError(401, 'Authentication required'));
      }
      if (!resolveAiCopilotEnabled(company)) {
        const err = new ApiError(403, 'AI Copilot is not enabled for your organization.');
        err.code = 'AI_COPILOT_DISABLED';
        throw err;
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireAiCopilot };
