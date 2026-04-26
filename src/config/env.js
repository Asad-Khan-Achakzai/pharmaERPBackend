const Joi = require('joi');
require('dotenv').config();

const schema = Joi.object({
  PORT: Joi.number().default(5000),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  MONGODB_URI: Joi.string().required(),
  JWT_ACCESS_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRY: Joi.string().default('1d'),
  JWT_REFRESH_EXPIRY: Joi.string().default('7d'),
  FRONTEND_URL: Joi.string().default('http://localhost:3000'),
  /** When not '0', resolve permissions from Role when user.roleId is set. Set to '0' for emergency legacy-only resolution. */
  USE_ROLE_BASED_AUTH: Joi.string().valid('0', '1').default('1')
}).unknown(true);

const { value: env, error } = schema.validate(process.env);

if (error) {
  throw new Error(`Environment validation error: ${error.message}`);
}

module.exports = env;
