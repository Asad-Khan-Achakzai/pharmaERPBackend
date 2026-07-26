const logger = require('../../utils/logger');
const AiInteractionLog = require('../models/AiInteractionLog');

async function logInteraction(payload) {
  try {
    await AiInteractionLog.create(payload);
  } catch (err) {
    logger.warn('AI interaction log failed', { error: err.message });
  }

  logger.info('ai.copilot.interaction', {
    companyId: String(payload.companyId),
    userId: String(payload.userId),
    provider: payload.provider,
    model: payload.model,
    success: payload.success,
    durationMs: payload.durationMs,
    toolCount: payload.toolCalls?.length || 0
  });
}

module.exports = { logInteraction };
