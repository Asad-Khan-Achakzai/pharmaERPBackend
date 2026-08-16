const mongoose = require('mongoose');

/**
 * Materialized per-user daily route summary (business-day granularity).
 *
 * Source of truth stays in AttendanceHeartbeat — this is a cache keyed by
 * `algorithmVersion` and invalidated by the `dirty` flag whenever late
 * (cross-day backfill) heartbeats are accepted for that day. Readers must
 * recompute when `dirty` is set or the version is stale, so a stale summary
 * can never be served.
 */
const dailyRouteSummarySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Business day in company timezone, formatted YYYY-MM-DD. */
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    timeZone: { type: String, default: null },
    algorithmVersion: { type: Number, required: true },
    dirty: { type: Boolean, default: false },
    summary: { type: mongoose.Schema.Types.Mixed, default: null },
    quality: { type: mongoose.Schema.Types.Mixed, default: null },
    pointStats: { type: mongoose.Schema.Types.Mixed, default: null },
    computedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

dailyRouteSummarySchema.index({ companyId: 1, userId: 1, date: 1 }, { unique: true });
dailyRouteSummarySchema.index({ companyId: 1, date: 1 });
dailyRouteSummarySchema.index({ dirty: 1, companyId: 1 });

module.exports = mongoose.model('DailyRouteSummary', dailyRouteSummarySchema);
