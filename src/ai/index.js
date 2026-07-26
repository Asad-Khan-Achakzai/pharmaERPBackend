const router = require('./routes/ai.routes');
const aiEnv = require('./config/aiEnv');
const { getProvider } = require('./config/providerRegistry');
const logger = require('../utils/logger');

async function initAiModule() {
  if (!aiEnv.globalEnabled) {
    logger.info('AI Copilot module loaded (globally disabled via AI_GLOBAL_ENABLED)');
    return;
  }
  try {
    const provider = getProvider();
    logger.info(`AI Copilot initialized — provider=${provider.getName()} model=${provider.getModel()}`);
    if (provider.getName() === 'ollama') {
      const res = await fetch(`${aiEnv.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (!res?.ok) {
        logger.warn(`AI Copilot: Ollama not reachable at ${aiEnv.ollamaBaseUrl} — chat will return friendly errors until available`);
      }
    }
  } catch (err) {
    logger.warn(`AI Copilot provider init warning: ${err.message}`);
  }
}

module.exports = { router, initAiModule };
