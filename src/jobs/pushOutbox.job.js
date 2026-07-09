const cron = require('node-cron');
const logger = require('../utils/logger');
const pushOutboxService = require('../services/pushOutbox.service');

function startPushOutboxJob() {
  cron.schedule(
    '*/15 * * * * *',
    async () => {
      try {
        const result = await pushOutboxService.processOutboxBatch();
        if (result.processed > 0) {
          logger.info('push.outbox_tick', result);
        }
      } catch (err) {
        logger.error('push.outbox_job_failed', err);
      }
    },
    { timezone: 'UTC' }
  );
  logger.info('Scheduled: push outbox worker (every 15s UTC)');
}

module.exports = { startPushOutboxJob };
