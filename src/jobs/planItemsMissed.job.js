const cron = require('node-cron');
const logger = require('../utils/logger');
const planItemService = require('../services/planItem.service');

/**
 * Near end of each company's business day: mark remaining PENDING plan items for that calendar day as MISSED.
 */
function startPlanItemsMissedJob() {
  cron.schedule(
    '*/5 * * * *',
    async () => {
      try {
        const n = await planItemService.runPlanItemsMissedTick();
        if (n > 0) {
          logger.info(`Plan items marked MISSED (company TZ window): ${n} row(s)`);
        }
      } catch (err) {
        logger.error('Plan items missed job failed', err);
      }
    },
    { timezone: 'UTC' }
  );
  logger.info('Scheduled: plan-items MISSED tick (every 5m UTC, per-company 23:55+ local)');
}

module.exports = { startPlanItemsMissedJob };
