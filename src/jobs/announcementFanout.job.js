const cron = require('node-cron');
const logger = require('../utils/logger');
const announcementFanoutService = require('../services/announcementFanout.service');

function startAnnouncementFanoutJob() {
  cron.schedule(
    '*/20 * * * * *',
    async () => {
      try {
        const result = await announcementFanoutService.processFanoutBatch();
        if (result.processedJobs > 0) {
          logger.info('announcement.fanout_tick', result);
        }
      } catch (err) {
        logger.error('announcement.fanout_job_failed', err);
      }
    },
    { timezone: 'UTC' }
  );
  logger.info('Scheduled: announcement fan-out worker (every 20s UTC)');
}

module.exports = { startAnnouncementFanoutJob };
