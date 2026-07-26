const aiEnv = require('./aiEnv');
const OllamaProvider = require('../providers/OllamaProvider');
const OpenAIProvider = require('../providers/OpenAIProvider');

let cached = null;

function createProvider() {
  switch (aiEnv.provider) {
    case 'ollama':
      return new OllamaProvider();
    case 'openai':
    case 'azure-openai':
      return new OpenAIProvider();
    default:
      throw new Error(`Unsupported AI provider: ${aiEnv.provider}`);
  }
}

function getProvider() {
  if (!cached) cached = createProvider();
  return cached;
}

function resetProviderCache() {
  cached = null;
}

module.exports = { createProvider, getProvider, resetProviderCache };
