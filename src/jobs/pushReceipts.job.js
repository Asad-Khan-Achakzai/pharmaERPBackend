const cron = require('node-cron');
const logger = require('../utils/logger');
const pushOutboxService = require('../services/pushOutbox.service');

function startPushReceiptsJob() {
  cron.schedule(
    '*/2 * * * *',
    async () => {
      try {
        const result = await pushOutboxService.processReceiptBatch();
        if (result.rows > 0) {
          logger.info('push.receipts_tick', result);
        }
      } catch (err) {
        logger.error('push.receipts_job_failed', err);
      }
    },
    { timezone: 'UTC' }
  );
  logger.info('Scheduled: push receipts worker (every 2m UTC)');
}

module.exports = { startPushReceiptsJob };
