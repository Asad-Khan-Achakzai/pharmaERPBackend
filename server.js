const app = require('./src/app');
const connectDB = require('./src/config/database');
const env = require('./src/config/env');
const logger = require('./src/utils/logger');
const { startAttendanceAutoCheckoutJob } = require('./src/jobs/attendanceAutoCheckout.job');
const { startAttendanceApprovalAutomationJob } = require('./src/jobs/attendanceApprovalAutomation.job');
const { startPlanItemsMissedJob } = require('./src/jobs/planItemsMissed.job');
const { startMediaRetentionCleanupJob } = require('./src/jobs/mediaRetentionCleanup.job');
const { seedMrepRolesForAllCompanies } = require('./src/jobs/seedMrepRoles.bootstrap');
const realtimeHub = require('./src/realtime/RealtimeHub');
const { initHeartbeatRateLimit } = require('./src/utils/heartbeatRateLimit');

const startServer = async () => {
  await connectDB();
  await realtimeHub.init();
  await initHeartbeatRateLimit();

  if (env.NODE_ENV !== 'test') {
    startAttendanceAutoCheckoutJob();
    startAttendanceApprovalAutomationJob();
    startPlanItemsMissedJob();
    startMediaRetentionCleanupJob();
    /** Idempotent — ensures every company has DEFAULT_ASM + DEFAULT_RM seeded. */
    void seedMrepRolesForAllCompanies();
  }

  app.listen(env.PORT, '0.0.0.0', () => {
    logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  });
};

startServer().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
