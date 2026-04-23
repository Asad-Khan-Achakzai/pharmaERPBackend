const cron = require('node-cron');
const logger = require('../utils/logger');
const attendanceService = require('../services/attendance.service');

/**
 * Runs at 12:01 AM Pacific: close out previous calendar day for anyone still checked in.
 */
function startAttendanceAutoCheckoutJob() {
  cron.schedule(
    '1 0 * * *',
    async () => {
      try {
        const n = await attendanceService.runAutoCheckoutPst();
        logger.info(`Attendance auto-checkout: ${n} record(s) updated`);
      } catch (err) {
        logger.error('Attendance auto-checkout failed', err);
      }
    },
    { timezone: 'America/Los_Angeles' }
  );
  logger.info('Scheduled: attendance auto-checkout at 12:01 AM America/Los_Angeles');
}

module.exports = { startAttendanceAutoCheckoutJob };
