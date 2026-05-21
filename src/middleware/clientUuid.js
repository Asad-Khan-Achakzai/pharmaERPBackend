const crypto = require('crypto');
const IdempotencyRecord = require('../models/IdempotencyRecord');

/**
 * Idempotent-write middleware for mobile writes.
 *
 * Behaviour:
 *   - No-op for the web app (no `X-Client-Uuid` header).
 *   - For mobile writes (POST/PUT/PATCH/DELETE with `X-Client-Uuid`):
 *       1. If a prior record exists for the same (user, clientUuid), short-
 *          circuit and replay the original status+body. The action is NOT
 *          re-executed.
 *       2. Otherwise we wrap `res.json` so a successful response is persisted
 *          to `IdempotencyRecord` (TTL 24h).
 *   - Failed responses (status >= 400) are NOT persisted, so the client can
 *     retry after fixing the input.
 *
 * Mount this AFTER `authenticate` but BEFORE controllers so we know `userId`.
 */
function clientUuid() {
  return async function clientUuidMiddleware(req, res, next) {
    const method = String(req.method || '').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

    const headerValue = req.get('X-Client-Uuid');
    if (!headerValue) return next();

    const userId = req.user && req.user.userId ? String(req.user.userId) : null;
    if (!userId) return next();

    const trimmed = String(headerValue).trim().slice(0, 64);
    if (!trimmed) return next();
    req.clientUuid = trimmed;

    const key = `${userId}:${trimmed}`;

    try {
      const existing = await IdempotencyRecord.findOne({ key }).lean();
      if (existing) {
        res.set('X-Idempotent-Replay', '1');
        return res.status(existing.statusCode).json(existing.responseBody);
      }
    } catch (err) {
      return next(err);
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        const safeKey = key;
        const safeBody = body;
        IdempotencyRecord.create({
          key: safeKey,
          userId,
          method,
          path: req.originalUrl ? req.originalUrl.slice(0, 256) : '',
          statusCode: status,
          responseBody: safeBody
        }).catch(() => undefined);
      }
      return originalJson(body);
    };

    next();
  };
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { clientUuid, hashRefreshToken };
