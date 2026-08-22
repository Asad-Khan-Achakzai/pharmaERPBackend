const crypto = require('crypto');
const IdempotencyRecord = require('../models/IdempotencyRecord');

const CHECKIN_LOCK_STATUS = 0;
const checkInLockConfig = {
  waitMs: 25_000,
  staleMs: 45_000,
  pollMs: 200
};

function isAttendanceCheckInRequest(req) {
  const method = String(req.method || '').toUpperCase();
  if (method !== 'POST') return false;
  const url = String(req.originalUrl || req.path || '')
    .split('?')[0]
    .replace(/\/+$/, '');
  return /\/attendance\/checkin$/.test(url);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDupKey(err) {
  return Boolean(err && (err.code === 11000 || err.code === '11000'));
}

function replay(res, record) {
  res.set('X-Idempotent-Replay', '1');
  return res.status(record.statusCode).json(record.responseBody);
}

function isCompletedRecord(record) {
  return Boolean(
    record &&
      record.statusCode >= 200 &&
      record.statusCode < 300 &&
      record.responseBody != null
  );
}

async function waitForCheckInRecord(key, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = await IdempotencyRecord.findOne({ key }).lean();
    if (!row || isCompletedRecord(row)) return row || null;
    await sleep(checkInLockConfig.pollMs);
  }
  return IdempotencyRecord.findOne({ key }).lean();
}

function wrapJsonPersistCreate(res, { key, userId, method, path }) {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const status = res.statusCode;
    if (status >= 200 && status < 300) {
      IdempotencyRecord.create({
        key,
        userId,
        method,
        path,
        statusCode: status,
        responseBody: body
      }).catch(() => undefined);
    }
    return originalJson(body);
  };
}

function wrapJsonCheckInLock(res, { key, userId, method, path }) {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const status = res.statusCode;
    if (status >= 200 && status < 300) {
      IdempotencyRecord.updateOne(
        { key },
        {
          $set: {
            userId,
            method,
            path,
            statusCode: status,
            responseBody: body
          }
        }
      )
        .then((result) => {
          if (result && result.matchedCount === 0) {
            return IdempotencyRecord.create({
              key,
              userId,
              method,
              path,
              statusCode: status,
              responseBody: body
            });
          }
          return result;
        })
        .catch(() => undefined);
    } else {
      IdempotencyRecord.deleteOne({ key, statusCode: CHECKIN_LOCK_STATUS }).catch(() => undefined);
    }
    return originalJson(body);
  };
}

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
 *   - POST /attendance/checkin additionally takes an atomic in-progress lock
 *     (`statusCode: 0`) so two in-flight requests with the same UUID cannot
 *     both execute checkIn.
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
    const path = req.originalUrl ? req.originalUrl.slice(0, 256) : '';

    if (!isAttendanceCheckInRequest(req)) {
      try {
        const existing = await IdempotencyRecord.findOne({ key }).lean();
        if (existing) {
          return replay(res, existing);
        }
      } catch (err) {
        return next(err);
      }
      wrapJsonPersistCreate(res, { key, userId, method, path });
      return next();
    }

    try {
      await IdempotencyRecord.create({
        key,
        userId,
        method,
        path,
        statusCode: CHECKIN_LOCK_STATUS,
        responseBody: null
      });
      wrapJsonCheckInLock(res, { key, userId, method, path });
      return next();
    } catch (err) {
      if (!isDupKey(err)) return next(err);
    }

    try {
      let existing = await IdempotencyRecord.findOne({ key }).lean();
      if (isCompletedRecord(existing)) {
        return replay(res, existing);
      }

      existing = await waitForCheckInRecord(key, checkInLockConfig.waitMs);
      if (isCompletedRecord(existing)) {
        return replay(res, existing);
      }

      if (!existing) {
        wrapJsonPersistCreate(res, { key, userId, method, path });
        return next();
      }

      const age = existing.createdAt ? Date.now() - new Date(existing.createdAt).getTime() : 0;
      if (existing.statusCode === CHECKIN_LOCK_STATUS && age > checkInLockConfig.staleMs) {
        await IdempotencyRecord.deleteOne({ key, statusCode: CHECKIN_LOCK_STATUS });
        wrapJsonPersistCreate(res, { key, userId, method, path });
        return next();
      }

      return res.status(503).json({
        success: false,
        statusCode: 503,
        message: 'Check-in is already in progress',
        code: 'ATTENDANCE_CHECKIN_IN_PROGRESS'
      });
    } catch (err) {
      return next(err);
    }
  };
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = {
  clientUuid,
  hashRefreshToken,
  isAttendanceCheckInRequest,
  checkInLockConfig
};
