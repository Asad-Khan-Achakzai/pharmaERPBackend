const GeoUsageLog = require('../models/GeoUsageLog');
const { resolveGeoPlatform } = require('../utils/geoPlatformResolver');
const ApiError = require('../../utils/ApiError');

async function assertWithinDailyQuota(companyId, company) {
  const geo = resolveGeoPlatform(company);
  const limit = geo.limits?.maxGoogleCallsPerDay;
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return;

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const count = await GeoUsageLog.countDocuments({
    companyId,
    createdAt: { $gte: start }
  });
  if (count >= limit) {
    const err = new ApiError(429, 'Daily Google Maps API quota exceeded for this company');
    err.code = 'GEO_QUOTA_EXCEEDED';
    throw err;
  }
}

async function recordUsage({ companyId, userId, api, operation, units = 1, costEstimateUsd = null, metadata = null }) {
  await GeoUsageLog.create({
    companyId,
    userId: userId || null,
    api,
    operation,
    units,
    costEstimateUsd,
    metadata
  });
}

async function getUsageSummary(companyId, { from, to } = {}) {
  const match = { companyId };
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = new Date(from);
    if (to) match.createdAt.$lte = new Date(to);
  }

  const rows = await GeoUsageLog.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$api',
        calls: { $sum: 1 },
        units: { $sum: '$units' },
        costEstimateUsd: { $sum: { $ifNull: ['$costEstimateUsd', 0] } }
      }
    },
    { $sort: { calls: -1 } }
  ]);

  return rows.map((r) => ({
    api: r._id,
    calls: r.calls,
    units: r.units,
    costEstimateUsd: r.costEstimateUsd
  }));
}

module.exports = { assertWithinDailyQuota, recordUsage, getUsageSummary };
