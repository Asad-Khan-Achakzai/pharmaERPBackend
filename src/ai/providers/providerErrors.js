class ProviderUnavailableError extends Error {
  constructor(message = 'AI Copilot is temporarily unavailable. Please try again later.') {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.userMessage = message;
  }
}

class ProviderTimeoutError extends Error {
  constructor(message = 'AI Copilot took too long to respond. Please try again.') {
    super(message);
    this.name = 'ProviderTimeoutError';
    this.userMessage = message;
  }
}

module.exports = { ProviderUnavailableError, ProviderTimeoutError };
