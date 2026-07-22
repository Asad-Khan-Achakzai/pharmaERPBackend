const NotificationOutbox = require('../models/NotificationOutbox');
const { OUTBOX_STATUS } = require('../models/NotificationOutbox');
const { PUSH_STATUS } = require('../models/Notification');
const pushService = require('./push.service');
const {
  MAX_ATTEMPTS,
  nextAttemptAt,
  isPermanentPushError
} = require('../utils/pushOutboxBackoff');
const logger = require('../utils/logger');

const BATCH_SIZE = 50;

/**
 * Claim and process due outbox rows. Safe to run concurrently across ticks
 * via findOneAndUpdate claim pattern.
 */
async function processOutboxBatch(limit = BATCH_SIZE) {
  if (!pushService.isPushConfigured()) {
    return { processed: 0, sent: 0, failed: 0, skipped: true };
  }

  let processed = 0;
  let sent = 0;
  let failed = 0;
  const now = new Date();

  for (let i = 0; i < limit; i += 1) {
    const row = await NotificationOutbox.findOneAndUpdate(
      {
        status: OUTBOX_STATUS.PENDING,
        nextAttemptAt: { $lte: now }
      },
      { $set: { status: OUTBOX_STATUS.PROCESSING } },
      { sort: { nextAttemptAt: 1 }, new: true }
    );

    if (!row) break;
    processed += 1;

    const payload = row.payload || {};
    try {
      const result = await pushService.sendToUser({
        userId: row.userId,
        title: payload.title,
        body: payload.body,
        data: payload.data || {},
        badge: payload.badge,
        channelId: payload.channelId || 'default'
      });

      if (result.skipped) {
        row.status = OUTBOX_STATUS.SKIPPED;
        row.processedAt = new Date();
        row.lastError = 'backend_not_configured';
        await row.save();
        await pushService.markNotificationPushStatus(
          row.notificationId,
          PUSH_STATUS.SKIPPED,
          'backend_not_configured'
        );
        continue;
      }

      if (result.sent > 0) {
        row.status = OUTBOX_STATUS.SENT;
        row.ticketIds = result.ticketIds || [];
        row.processedAt = new Date();
        row.lastError = null;
        await row.save();
        await pushService.markNotificationPushStatus(row.notificationId, PUSH_STATUS.SENT);
        sent += 1;
        logger.info('push.outbox_sent', {
          outboxId: String(row._id),
          notificationId: String(row.notificationId),
          userId: String(row.userId),
          tickets: row.ticketIds.length
        });
        continue;
      }

      // No tokens or all tickets failed without throw
      row.attempts += 1;
      if (result.permanentFailure || row.attempts >= MAX_ATTEMPTS) {
        row.status = OUTBOX_STATUS.DEAD;
        row.processedAt = new Date();
        row.lastError = result.permanentFailure ? 'permanent_failure' : 'max_attempts_no_tokens';
        await row.save();
        await pushService.markNotificationPushStatus(
          row.notificationId,
          PUSH_STATUS.FAILED,
          row.lastError
        );
        failed += 1;
      } else {
        row.status = OUTBOX_STATUS.PENDING;
        row.nextAttemptAt = nextAttemptAt(row.attempts);
        row.lastError = 'no_tokens_or_all_failed';
        await row.save();
        failed += 1;
      }
    } catch (err) {
      row.attempts += 1;
      const permanent = isPermanentPushError(err) || false;
      row.lastError = String(err.message || err).slice(0, 500);
      if (permanent || row.attempts >= MAX_ATTEMPTS) {
        row.status = OUTBOX_STATUS.DEAD;
        row.processedAt = new Date();
        await row.save();
        await pushService.markNotificationPushStatus(
          row.notificationId,
          PUSH_STATUS.FAILED,
          row.lastError
        );
        failed += 1;
      } else {
        row.status = OUTBOX_STATUS.PENDING;
        row.nextAttemptAt = nextAttemptAt(row.attempts);
        await row.save();
        failed += 1;
      }
      logger.error('push.outbox_send_error', {
        outboxId: String(row._id),
        attempts: row.attempts,
        err: err.message
      });
    }
  }

  return { processed, sent, failed, skipped: false };
}

/**
 * Poll Expo receipts for recently sent outbox rows that still have ticket ids.
 */
async function processReceiptBatch(limit = 100) {
  const rows = await NotificationOutbox.find({
    status: OUTBOX_STATUS.SENT,
    ticketIds: { $exists: true, $ne: [] },
    processedAt: { $lte: new Date(Date.now() - 60_000) }
  })
    .sort({ processedAt: 1 })
    .limit(limit)
    .lean();

  if (!rows.length) return { rows: 0, delivered: 0, failed: 0, pruned: 0 };

  let delivered = 0;
  let failed = 0;
  let pruned = 0;

  for (const row of rows) {
    const result = await pushService.processReceipts(row.ticketIds);
    delivered += result.delivered;
    failed += result.failed;
    pruned += result.pruned;

    if (result.delivered > 0 && result.failed === 0) {
      await pushService.markNotificationPushStatus(row.notificationId, PUSH_STATUS.DELIVERED);
      await NotificationOutbox.updateOne(
        { _id: row._id },
        { $set: { ticketIds: [] } }
      );
    } else if (result.failed > 0 && result.delivered === 0) {
      await pushService.markNotificationPushStatus(
        row.notificationId,
        PUSH_STATUS.FAILED,
        'receipt_failed'
      );
      await NotificationOutbox.updateOne(
        { _id: row._id },
        { $set: { ticketIds: [], lastError: 'receipt_failed' } }
      );
    } else if (result.delivered > 0) {
      await pushService.markNotificationPushStatus(row.notificationId, PUSH_STATUS.DELIVERED);
      await NotificationOutbox.updateOne({ _id: row._id }, { $set: { ticketIds: [] } });
    }
  }

  return { rows: rows.length, delivered, failed, pruned };
}

module.exports = { processOutboxBatch, processReceiptBatch, BATCH_SIZE };
