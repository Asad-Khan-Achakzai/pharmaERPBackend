const cron = require('node-cron');
const logger = require('../utils/logger');
const planItemService = require('../services/planItem.service');
const { pstTodayYmd } = require('../utils/attendancePst');

/**
 * End of Pacific business day: mark remaining PENDING plan items for that calendar day as MISSED.
 */
function startPlanItemsMissedJob() {
  cron.schedule(
    '55 23 * * *',
    async () => {
      try {
        const ymd = pstTodayYmd();
        const n = await planItemService.markMissedForPstDate(ymd);
        logger.info(`Plan items marked MISSED for ${ymd}: ${n} row(s)`);
      } catch (err) {
        logger.error('Plan items missed job failed', err);
      }
    },
    { timezone: 'America/Los_Angeles' }
  );
  logger.info('Scheduled: plan-items MISSED at 11:55 PM America/Los_Angeles');
}

module.exports = { startPlanItemsMissedJob };
