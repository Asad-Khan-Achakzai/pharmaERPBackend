const mongoose = require('mongoose');

/**
 * Server-side dedupe ledger for mobile mutations. Mobile clients send
 * `X-Client-Uuid` for every non-GET request; on first success we persist the
 * response envelope here so retries (after network failures, app crashes, or
 * outbox replay) return the same payload without re-executing the action.
 *
 * `ttlIndex` deletes records 24h after creation — long enough to cover the
 * worst-case outbox replay and short enough to keep this collection tiny.
 *
 * The web app does not send `X-Client-Uuid`, so the middleware bypasses
 * idempotency entirely for non-mobile clients. Existing web behaviour is
 * unchanged.
 */
const idempotencyRecordSchema = new mongoose.Schema(
  {
    /** `<userId>:<clientUuid>` — scoped per user so two users cannot collide. */
    key: { type: String, required: true },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    method: { type: String, required: true },
    path: { type: String, required: true },
    statusCode: { type: Number, required: true },
    responseBody: { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 }
  },
  { versionKey: false }
);

idempotencyRecordSchema.index({ key: 1 }, { unique: true });

module.exports = mongoose.model('IdempotencyRecord', idempotencyRecordSchema);
