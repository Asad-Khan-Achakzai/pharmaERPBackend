const cron = require('node-cron');
const Company = require('../models/Company');
const logger = require('../utils/logger');
const notificationAnalyticsService = require('../services/notificationAnalytics.service');

function startNotificationAnalyticsJob() {
  cron.schedule(
    '15 * * * *',
    async () => {
      try {
        const companies = await Company.find({ isActive: true }).select('_id').lean();
        for (const c of companies) {
          await notificationAnalyticsService.rollupDay(c._id);
        }
        logger.info('notification.analytics_tick', { companies: companies.length });
      } catch (err) {
        logger.error('notification.analytics_job_failed', err);
      }
    },
    { timezone: 'UTC' }
  );
  logger.info('Scheduled: notification analytics rollup (hourly at :15 UTC)');
}

module.exports = { startNotificationAnalyticsJob };
