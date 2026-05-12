const cron = require('node-cron');
const logger = require('../utils/logger');
const attendanceWorkflowService = require('../services/attendanceWorkflow.service');

/**
 * SLA / end-of-day / auto-rejection policies for attendance requests.
 * Runs frequently; idempotent per-request keys inside the workflow service.
 */
function startAttendanceApprovalAutomationJob() {
  cron.schedule(
    '*/10 * * * *',
    async () => {
      try {
        const n = await attendanceWorkflowService.runAttendanceRequestAutomationTick();
        if (n > 0) {
          logger.info(`Attendance approval automation: ${n} update(s)`);
        }
      } catch (err) {
        logger.error('Attendance approval automation failed', err);
      }
    },
    { timezone: 'UTC' }
  );
  logger.info('Scheduled: attendance approval automation (every 10m UTC)');
}

module.exports = { startAttendanceApprovalAutomationJob };
