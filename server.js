const app = require('./src/app');
const connectDB = require('./src/config/database');
const env = require('./src/config/env');
const logger = require('./src/utils/logger');
const { getPushBackendStatus } = require('./src/utils/pushDiagnostics');
const { startAttendanceAutoCheckoutJob } = require('./src/jobs/attendanceAutoCheckout.job');
const { startAttendanceApprovalAutomationJob } = require('./src/jobs/attendanceApprovalAutomation.job');
const { startPlanItemsMissedJob } = require('./src/jobs/planItemsMissed.job');
const { seedMrepRolesForAllCompanies } = require('./src/jobs/seedMrepRoles.bootstrap');

const startServer = async () => {
  await connectDB();

  if (env.NODE_ENV !== 'test') {
    startAttendanceAutoCheckoutJob();
    startAttendanceApprovalAutomationJob();
    startPlanItemsMissedJob();
    /** Idempotent — ensures every company has DEFAULT_ASM + DEFAULT_RM seeded. */
    void seedMrepRolesForAllCompanies();
  }

  const pushStatus = getPushBackendStatus();
  logger.info('push.backend_startup', {
    ...pushStatus,
    status: pushStatus.backendReady ? 'ready' : 'not_ready',
    fix: pushStatus.backendReady
      ? null
      : !pushStatus.expoSdkLoaded
        ? 'Run npm install expo-server-sdk in pharmaERPBackend'
        : 'Set EXPO_ACCESS_TOKEN in Render environment variables (Expo account → Access tokens)'
  });

  app.listen(env.PORT, '0.0.0.0', () => {
    logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  });
};

startServer().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
