const cron = require('node-cron');
const logger = require('../utils/logger');
const env = require('../config/env');
const mediaCleanupService = require('../services/mediaCleanup.service');

/**
 * Daily retention cleanup: removes expired TEMPORARY media assets from R2 and
 * marks them deleted. PERMANENT assets and assets with no expiry are never
 * touched (see mediaCleanup.service hard guards). Runs at 02:15 UTC daily.
 */
function startMediaRetentionCleanupJob() {
  cron.schedule(
    '15 2 * * *',
    async () => {
      try {
        const res = await mediaCleanupService.runMediaRetentionCleanupTick();
        if (res.scanned > 0) {
          logger.info(
            `Media retention cleanup: deleted ${res.deleted}, failed ${res.failed}, scanned ${res.scanned}`
          );
        }
      } catch (err) {
        logger.error('Media retention cleanup job failed', err);
      }
    },
    { timezone: 'UTC' }
  );
  logger.info(
    `Scheduled: media retention cleanup (daily 02:15 UTC, provider=${env.MEDIA_STORAGE_PROVIDER})`
  );
}

module.exports = { startMediaRetentionCleanupJob };
