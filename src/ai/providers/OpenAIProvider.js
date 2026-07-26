const { ProviderUnavailableError } = require('./providerErrors');

/** Stub — wire when OPENAI_API_KEY is configured. */
class OpenAIProvider {
  constructor() {
    throw new ProviderUnavailableError('OpenAI provider is not configured yet. Set AI_PROVIDER=ollama or implement OpenAIProvider.');
  }
}

module.exports = OpenAIProvider;
