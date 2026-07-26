const Joi = require('joi');
const rootEnv = require('../../config/env');

const aiSchema = Joi.object({
  AI_PROVIDER: Joi.string().valid('ollama', 'openai', 'claude', 'gemini', 'azure-openai').default('ollama'),
  AI_STREAMING: Joi.string().valid('0', '1', 'true', 'false').default('true'),
  AI_MAX_HISTORY: Joi.number().integer().min(4).max(100).default(20),
  AI_MAX_TOOL_ITERATIONS: Joi.number().integer().min(1).max(15).default(5),
  AI_REQUEST_TIMEOUT_MS: Joi.number().integer().min(5000).max(600000).default(120000),
  AI_RATE_LIMIT_PER_MINUTE: Joi.number().integer().min(1).max(1000).default(20),
  AI_GLOBAL_ENABLED: Joi.string().valid('0', '1', 'true', 'false').default('true'),
  OLLAMA_BASE_URL: Joi.string().uri({ allowRelative: false }).default('http://localhost:11434'),
  OLLAMA_MODEL: Joi.string().default('qwen3:30b-a3b'),
  OPENAI_API_KEY: Joi.string().allow('').default(''),
  OPENAI_MODEL: Joi.string().allow('').default('gpt-4o-mini')
}).unknown(true);

const { value, error } = aiSchema.validate(process.env, { convert: true });
if (error) {
  throw new Error(`AI environment validation error: ${error.message}`);
}

const truthy = (v) => v === true || v === '1' || v === 'true';

const aiEnv = {
  provider: value.AI_PROVIDER,
  streaming: truthy(value.AI_STREAMING),
  maxHistory: value.AI_MAX_HISTORY,
  maxToolIterations: value.AI_MAX_TOOL_ITERATIONS,
  requestTimeoutMs: value.AI_REQUEST_TIMEOUT_MS,
  rateLimitPerMinute: value.AI_RATE_LIMIT_PER_MINUTE,
  globalEnabled: truthy(value.AI_GLOBAL_ENABLED),
  ollamaBaseUrl: String(value.OLLAMA_BASE_URL).replace(/\/$/, ''),
  ollamaModel: value.OLLAMA_MODEL,
  openaiApiKey: value.OPENAI_API_KEY,
  openaiModel: value.OPENAI_MODEL,
  nodeEnv: rootEnv.NODE_ENV
};

module.exports = aiEnv;
