const DailyRouteSummary = require('../models/DailyRouteSummary');
const businessTime = require('../../utils/businessTime');
const { ROUTE_ALGORITHM_VERSION } = require('../utils/routeProcessing');

/**
 * Compute a day's summary from raw heartbeats and persist it (dirty cleared).
 * Lazy-requires routeHistory.service to avoid a circular dependency.
 */
async function computeAndStoreDailySummary(companyId, userId, ymd, timeZone, company) {
  const routeHistoryService = require('./routeHistory.service');
  let resolvedCompany = company;
  if (!resolvedCompany) {
    const Company = require('../../models/Company');
    resolvedCompany = await Company.findById(companyId)
      .select('geoPlatform liveTrackingEnabled timeZone')
      .lean();
  }
  const day = await routeHistoryService.getRouteHistory(companyId, userId, ymd, timeZone, {
    company: resolvedCompany,
    summaryOnly: true
  });

  await DailyRouteSummary.findOneAndUpdate(
    { companyId, userId, date: day.date },
    {
      $set: {
        timeZone: day.timeZone || null,
        algorithmVersion: ROUTE_ALGORITHM_VERSION,
        dirty: false,
        summary: day.summary,
        quality: day.quality,
        pointStats: day.pointStats || null,
        computedAt: new Date()
      }
    },
    { upsert: true, new: true }
  );

  return day;
}

/**
 * Read a day's summary, recomputing when it is missing, flagged dirty, or was
 * produced by an older algorithm version. Today (in company TZ) is always
 * computed fresh — the day is still in progress, so it is never materialized
 * here (checkout and the nightly job materialize completed days).
 */
async function getDailySummary(companyId, userId, ymd, timeZone, company) {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const todayYmd = businessTime.nowInBusinessTime(tz).toISODate();

  if (!ymd || ymd >= todayYmd) {
    const routeHistoryService = require('./routeHistory.service');
    return routeHistoryService.getRouteHistory(companyId, userId, ymd, timeZone, {
      company,
      summaryOnly: true
    });
  }

  const existing = await DailyRouteSummary.findOne({ companyId, userId, date: ymd }).lean();
  if (
    existing &&
    !existing.dirty &&
    existing.algorithmVersion === ROUTE_ALGORITHM_VERSION &&
    existing.summary
  ) {
    return {
      date: existing.date,
      companyDate: existing.date,
      timeZone: existing.timeZone || tz,
      userId: String(userId),
      summary: existing.summary,
      quality: existing.quality,
      pointStats: existing.pointStats || null
    };
  }

  return computeAndStoreDailySummary(companyId, userId, ymd, timeZone, company);
}

/**
 * Invalidate the materialized summary for the business day a heartbeat lands
 * on. Called from the single ingestion write path — cross-day backfill (31%
 * of user-days in production) makes this the primary correctness mechanism,
 * not an edge case. No-op when no summary exists yet (computed on demand).
 */
async function markDailySummaryDirty(companyId, userId, capturedAt, timeZone) {
  try {
    const tz = businessTime.requireCompanyIanaZone(timeZone);
    const ymd = businessTime.businessDayKeyFromUtcInstant(capturedAt, tz);
    await DailyRouteSummary.updateOne(
      { companyId, userId, date: ymd, dirty: { $ne: true } },
      { $set: { dirty: true } }
    );
  } catch {
    // Invalidation is best-effort; the algorithmVersion check and nightly job
    // provide the backstop.
  }
}

module.exports = {
  computeAndStoreDailySummary,
  getDailySummary,
  markDailySummaryDirty,
  ROUTE_ALGORITHM_VERSION
};
