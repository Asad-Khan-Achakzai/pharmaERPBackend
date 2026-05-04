const cron = require('node-cron');
const logger = require('../utils/logger');
const attendanceService = require('../services/attendance.service');

/**
 * Per-company business calendar: shortly after local midnight, close previous day for anyone still checked in.
 */
function startAttendanceAutoCheckoutJob() {
  cron.schedule(
    '*/15 * * * *',
    async () => {
      try {
        const n = await attendanceService.runAutoCheckoutTick();
        if (n > 0) {
          logger.info(`Attendance auto-checkout: ${n} record(s) updated`);
        }
      } catch (err) {
        logger.error('Attendance auto-checkout failed', err);
      }
    },
    { timezone: 'UTC' }
  );
  logger.info('Scheduled: attendance auto-checkout (every 15m UTC, company-local midnight window)');
}

module.exports = { startAttendanceAutoCheckoutJob };
