const app = require('./src/app');
const connectDB = require('./src/config/database');
const env = require('./src/config/env');
const logger = require('./src/utils/logger');
const { startAttendanceAutoCheckoutJob } = require('./src/jobs/attendanceAutoCheckout.job');
const { startPlanItemsMissedJob } = require('./src/jobs/planItemsMissed.job');

const startServer = async () => {
  await connectDB();

  if (env.NODE_ENV !== 'test') {
    startAttendanceAutoCheckoutJob();
    startPlanItemsMissedJob();
  }

  app.listen(env.PORT, () => {
    logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  });
};

startServer().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
