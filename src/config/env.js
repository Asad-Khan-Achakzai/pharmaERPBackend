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
    .default(0),
  /**
   * Mobile media flags (Phase 0 additive). When false, /media/* endpoints
   * return 503 MEDIA_DISABLED and the mobile UI shows non-interactive shells.
   * Defaults are intentionally false until S3-like storage is configured for
   * the tenant. Core flows (visits, orders, attendance, expenses) MUST work
   * with every flag disabled.
   */
  ENABLE_MEDIA_UPLOAD: Joi.string().valid('0', '1').default('0'),
  ENABLE_VISIT_PHOTOS: Joi.string().valid('0', '1').default('0'),
  ENABLE_EXPENSE_RECEIPTS: Joi.string().valid('0', '1').default('0'),
  ENABLE_PRODUCT_MEDIA: Joi.string().valid('0', '1').default('0'),
  /**
   * Optional storage configuration. Only consulted when ENABLE_MEDIA_UPLOAD=1.
   * Leave blank to keep media disabled.
   */
  MEDIA_STORAGE_PROVIDER: Joi.string().valid('none', 's3', 'gcs', 'r2').default('none'),
  MEDIA_BUCKET: Joi.string().allow('').default(''),
  MEDIA_REGION: Joi.string().allow('').default(''),
  MEDIA_PUBLIC_BASE_URL: Joi.string().allow('').default(''),
  MEDIA_MAX_FILE_SIZE: Joi.number().integer().default(5 * 1024 * 1024),
  /**
   * Cloudflare R2 (S3-compatible) configuration. Only consulted when
   * MEDIA_STORAGE_PROVIDER=r2. Credentials are provided via environment.
   * The bucket is private — all access is via short-lived presigned URLs.
   */
  R2_ACCOUNT_ID: Joi.string().allow('').default(''),
  R2_ENDPOINT: Joi.string().allow('').default(''),
  R2_ACCESS_KEY_ID: Joi.string().allow('').default(''),
  R2_SECRET_ACCESS_KEY: Joi.string().allow('').default(''),
  R2_BUCKET: Joi.string().allow('').default(''),
  R2_REGION: Joi.string().allow('').default('auto'),
  /**
   * Signed URL TTLs (seconds). Short-lived access only — clients re-request a
   * fresh URL on expiry rather than caching long-lived links.
   */
  MEDIA_UPLOAD_URL_TTL_SECONDS: Joi.number().integer().min(30).max(3600).default(300),
  MEDIA_DOWNLOAD_URL_TTL_SECONDS: Joi.number().integer().min(30).max(3600).default(300),
  /** Mobile sync defaults. */
  MOBILE_SYNC_PAGE_SIZE: Joi.number().integer().min(10).max(500).default(50),
  MOBILE_SYNC_POLL_INTERVAL_MS: Joi.number().integer().min(15000).default(60000),
  /** Optional — Expo push notifications when Company.mobilePushEnabled is true. */
  EXPO_ACCESS_TOKEN: Joi.string().allow('').default(''),
  /** Geo Platform — server-side Google Maps API key (Routes, Geocoding, Places, Matrix). */
  GOOGLE_MAPS_SERVER_API_KEY: Joi.string().allow('').default(''),
  GOOGLE_MAPS_WEB_API_KEY: Joi.string().allow('').default(''),
  GOOGLE_MAPS_ANDROID_API_KEY: Joi.string().allow('').default(''),
  GOOGLE_MAPS_IOS_API_KEY: Joi.string().allow('').default(''),
  GEO_BILLING_MONITORING: Joi.string().valid('0', '1').default('0')
}).unknown(true);

const { value: env, error } = schema.validate(process.env, { convert: true });

if (error) {
  throw new Error(`Environment validation error: ${error.message}`);
}

module.exports = env;
