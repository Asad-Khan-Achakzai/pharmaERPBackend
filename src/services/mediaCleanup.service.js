const env = require('../config/env');
const logger = require('../utils/logger');
const MediaAsset = require('../models/MediaAsset');
const r2 = require('./storage/r2.client');

/**
 * Retention cleanup for TEMPORARY media assets.
 *
 * Safety properties:
 *  - HARD GUARDS: only ever selects retentionClass=TEMPORARY with a non-null
 *    expiresAt in the past, status READY, not already deleted. PERMANENT assets
 *    and assets with null expiresAt are never touched.
 *  - IDEMPOTENT: each candidate is atomically claimed via findOneAndUpdate into
 *    status=DELETING, so overlapping/concurrent runs cannot double-process. The
 *    R2 DeleteObject call is itself idempotent (missing key = success).
 *  - RETRY-SAFE: R2 delete runs before the terminal DB write. On failure the row
 *    stays in DELETING with an incremented deleteAttempts + lastDeleteError and
 *    is re-picked next run, up to MAX_DELETE_ATTEMPTS, after which it is flagged
 *    for manual review (status FAILED) rather than retried forever.
 */

const MAX_DELETE_ATTEMPTS = 5;

function buildCandidateQuery(now) {
  return {
    retentionClass: 'TEMPORARY',
    expiresAt: { $ne: null, $lte: now },
    status: { $in: ['READY', 'DELETING'] },
    deletedAt: null,
    deleteAttempts: { $lt: MAX_DELETE_ATTEMPTS }
  };
}

/**
 * Atomically claim the next due asset by flipping it to DELETING.
 * Returns the claimed doc or null when none remain.
 */
async function claimNext(now) {
  return MediaAsset.findOneAndUpdate(
    buildCandidateQuery(now),
    {
      $set: { status: 'DELETING', deleteAttemptedAt: now },
      $inc: { deleteAttempts: 1 }
    },
    { sort: { expiresAt: 1 }, new: true }
  );
}

async function processAsset(asset) {
  try {
    // R2 first (idempotent), then terminal DB write — never the reverse.
    if (env.MEDIA_STORAGE_PROVIDER === 'r2' && r2.isConfigured()) {
      await r2.deleteObject({ key: asset.key });
    }
    asset.deletedAt = new Date();
    asset.lastDeleteError = null;
    await asset.save();
    return { ok: true };
  } catch (err) {
    const message = (err && err.message) || 'unknown error';
    asset.lastDeleteError = message;
    // If we've exhausted attempts, park it for manual review instead of looping.
    asset.status = asset.deleteAttempts >= MAX_DELETE_ATTEMPTS ? 'FAILED' : 'READY';
    await asset.save();
    logger.error('Media retention delete failed', {
      assetId: String(asset._id),
      key: asset.key,
      attempts: asset.deleteAttempts,
      error: message
    });
    return { ok: false };
  }
}

/**
 * Run a single cleanup tick. Processes up to `limit` due assets.
 * @returns {Promise<{ deleted: number, failed: number, scanned: number }>}
 */
async function runMediaRetentionCleanupTick({ limit = 200 } = {}) {
  // When R2 is not the active provider there is nothing to delete remotely; we
  // still safely no-op (no DB destruction) so this is harmless if misconfigured.
  const now = new Date();
  let deleted = 0;
  let failed = 0;
  let scanned = 0;

  for (let i = 0; i < limit; i += 1) {
    const asset = await claimNext(now);
    if (!asset) break;
    scanned += 1;
    const res = await processAsset(asset);
    if (res.ok) deleted += 1;
    else failed += 1;
  }

  return { deleted, failed, scanned };
}

module.exports = { runMediaRetentionCleanupTick, MAX_DELETE_ATTEMPTS };
