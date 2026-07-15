const cron = require('node-cron');
const logger = require('../utils/logger');
const Company = require('../models/Company');
const AttendanceHeartbeat = require('../models/AttendanceHeartbeat');
const AttendanceHeartbeatArchive = require('../models/AttendanceHeartbeatArchive');
const { resolveGeoPlatform } = require('../geo/utils/geoPlatformResolver');

const BATCH = 500;
const DEFAULT_RETENTION_DAYS = 90;
/** Keep Mongo TTL (90d) as safety net; archive+delete earlier when retentionDays < 90. */
const MAX_HOT_DAYS = 90;

/**
 * Archive heartbeats older than each company's retentionDays into cold storage,
 * then delete from the hot collection. Runs daily at 03:10 UTC.
 */
async function runHeartbeatRetentionArchiveTick() {
  const companies = await Company.find({ isDeleted: { $ne: true } })
    .select('_id geoPlatform liveTrackingEnabled')
    .lean();

  let archived = 0;
  let deleted = 0;

  for (const company of companies) {
    const geo = resolveGeoPlatform(company);
    const retentionDays = Math.min(
      MAX_HOT_DAYS,
      Math.max(7, Number(geo.liveTracking?.retentionDays) || DEFAULT_RETENTION_DAYS)
    );
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    // eslint-disable-next-line no-await-in-loop
    let batch = await AttendanceHeartbeat.find({
      companyId: company._id,
      capturedAt: { $lt: cutoff }
    })
      .sort({ capturedAt: 1 })
      .limit(BATCH)
      .lean();

    while (batch.length) {
      const docs = batch.map((h) => ({
        companyId: h.companyId,
        userId: h.userId,
        lat: h.lat,
        lng: h.lng,
        accuracy: h.accuracy,
        confidence: h.confidence,
        speed: h.speed,
        heading: h.heading,
        trackingContext: h.trackingContext,
        expectedNextPingMs: h.expectedNextPingMs,
        capturedAt: h.capturedAt,
        clientUuid: h.clientUuid,
        source: h.source,
        battery: h.battery,
        archivedAt: new Date(),
        originalId: h._id
      }));

      // eslint-disable-next-line no-await-in-loop
      await AttendanceHeartbeatArchive.insertMany(docs, { ordered: false }).catch((err) => {
        if (err?.code !== 11000) throw err;
      });
      archived += docs.length;

      const ids = batch.map((h) => h._id);
      // eslint-disable-next-line no-await-in-loop
      const del = await AttendanceHeartbeat.deleteMany({ _id: { $in: ids } });
      deleted += del.deletedCount || 0;

      // eslint-disable-next-line no-await-in-loop
      batch = await AttendanceHeartbeat.find({
        companyId: company._id,
        capturedAt: { $lt: cutoff }
      })
        .sort({ capturedAt: 1 })
        .limit(BATCH)
        .lean();
    }
  }

  return { archived, deleted, companies: companies.length };
}

function startHeartbeatRetentionArchiveJob() {
  cron.schedule(
    '10 3 * * *',
    async () => {
      try {
        const res = await runHeartbeatRetentionArchiveTick();
        if (res.archived > 0 || res.deleted > 0) {
          logger.info(
            `Heartbeat retention archive: archived ${res.archived}, deleted ${res.deleted}, companies ${res.companies}`
          );
        }
      } catch (err) {
        logger.error('Heartbeat retention archive job failed', err);
      }
    },
    { timezone: 'UTC' }
  );
  logger.info('Scheduled: heartbeat retention archive (daily 03:10 UTC)');
}

module.exports = {
  startHeartbeatRetentionArchiveJob,
  runHeartbeatRetentionArchiveTick
};
