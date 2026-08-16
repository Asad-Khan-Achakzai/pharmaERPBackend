const cron = require('node-cron');
const mongoose = require('mongoose');
const logger = require('../utils/logger');
const Company = require('../models/Company');
const AttendanceHeartbeat = require('../models/AttendanceHeartbeat');
const DailyRouteSummary = require('../geo/models/DailyRouteSummary');
const businessTime = require('../utils/businessTime');
const { resolveGeoPlatform } = require('../geo/utils/geoPlatformResolver');
const {
  computeAndStoreDailySummary,
  ROUTE_ALGORITHM_VERSION
} = require('../geo/services/dailyRouteSummary.service');

const MAX_DIRTY_PER_COMPANY = 200;

/**
 * Nightly materialization:
 * 1. Compute yesterday's summary for every user that produced heartbeats
 *    (covers auto-checkout / crashed-checkout days the checkout hook missed).
 * 2. Recompute summaries flagged dirty by late backfill or produced by an
 *    older algorithm version, so stale rows never linger.
 */
async function runDailyRouteSummaryTick() {
  const companies = await Company.find({ isDeleted: { $ne: true } })
    .select('_id geoPlatform liveTrackingEnabled timeZone')
    .lean();

  let computed = 0;
  let failed = 0;

  for (const company of companies) {
    const geo = resolveGeoPlatform(company);
    const liveEnabled = company.liveTrackingEnabled === true || geo.features?.liveTracking === true;
    if (!liveEnabled) continue;

    let tz;
    try {
      tz = businessTime.requireCompanyIanaZone(company.timeZone);
    } catch {
      continue; // company not onboarded with a timezone yet
    }

    const yesterdayYmd = businessTime.nowInBusinessTime(tz).minus({ days: 1 }).toISODate();
    const range = businessTime.businessDayToUtcRange(yesterdayYmd, tz);
    const cid = new mongoose.Types.ObjectId(String(company._id));

    // eslint-disable-next-line no-await-in-loop
    const userIds = await AttendanceHeartbeat.distinct('userId', {
      companyId: cid,
      capturedAt: { $gte: range.$gte, $lte: range.$lte }
    });

    // eslint-disable-next-line no-await-in-loop
    const staleRows = await DailyRouteSummary.find({
      companyId: cid,
      $or: [{ dirty: true }, { algorithmVersion: { $ne: ROUTE_ALGORITHM_VERSION } }]
    })
      .select('userId date')
      .limit(MAX_DIRTY_PER_COMPANY)
      .lean();

    const work = new Map();
    for (const uid of userIds) work.set(`${uid}_${yesterdayYmd}`, { userId: uid, ymd: yesterdayYmd });
    for (const row of staleRows) {
      work.set(`${row.userId}_${row.date}`, { userId: row.userId, ymd: row.date });
    }

    const todayYmd = businessTime.nowInBusinessTime(tz).toISODate();
    for (const { userId, ymd } of work.values()) {
      if (ymd >= todayYmd) continue; // in-progress days are computed on read
      try {
        // eslint-disable-next-line no-await-in-loop
        await computeAndStoreDailySummary(company._id, userId, ymd, tz, company);
        computed += 1;
      } catch (err) {
        failed += 1;
        logger.error(
          `Daily route summary failed for user ${userId} on ${ymd}: ${err.message}`
        );
      }
    }
  }

  return { computed, failed, companies: companies.length };
}

function startDailyRouteSummaryJob() {
  cron.schedule(
    '40 2 * * *',
    async () => {
      try {
        const res = await runDailyRouteSummaryTick();
        if (res.computed > 0 || res.failed > 0) {
          logger.info(
            `Daily route summaries: computed ${res.computed}, failed ${res.failed}`
          );
        }
      } catch (err) {
        logger.error('Daily route summary job failed', err);
      }
    },
    { timezone: 'UTC' }
  );
  logger.info('Scheduled: daily route summaries (daily 02:40 UTC)');
}

module.exports = { startDailyRouteSummaryJob, runDailyRouteSummaryTick };
