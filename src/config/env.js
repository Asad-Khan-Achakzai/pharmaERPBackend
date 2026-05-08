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
  USE_ROLE_BASED_AUTH: Joi.string().valid('0', '1').default('1'),
  /** When '1', visits must be completed in sequence order (no out-of-order even with reason). */
  STRICT_VISIT_SEQUENCE: Joi.string().valid('0', '1').default('0'),
  /** Pakistan PRAL-style advance tax shown on delivery invoice PDF only (% of pharmacy net). Default 0 = line shows 0.00. */
  INVOICE_ADVANCE_TAX_236H_PERCENT: Joi.any()
    .custom((v) => {
      if (v === '' || v === undefined || v === null) return 0;
      const n = typeof v === 'number' ? v : parseFloat(String(v).trim(), 10);
      if (!Number.isFinite(n) || n < 0) return 0;
      return Math.min(n, 100);
    })
    .default(0)
}).unknown(true);

const { value: env, error } = schema.validate(process.env, { convert: true });

if (error) {
  throw new Error(`Environment validation error: ${error.message}`);
}

module.exports = env;
