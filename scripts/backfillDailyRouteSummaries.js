/**
 * Backfill DailyRouteSummary rows for historical heartbeats in the hot
 * retention window (raw AttendanceHeartbeat data is never modified).
 *
 * Dry-run (default):
 *   node scripts/backfillDailyRouteSummaries.js
 *
 * Apply:
 *   node scripts/backfillDailyRouteSummaries.js --apply
 *
 * Optional:
 *   --company=<id>   limit to one company
 *   --days=<n>       how far back to backfill (default 90)
 *   --force          recompute even when a fresh summary already exists
 *
 * Env: MONGODB_URI
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');
const AttendanceHeartbeat = require('../src/models/AttendanceHeartbeat');
const DailyRouteSummary = require('../src/geo/models/DailyRouteSummary');
const businessTime = require('../src/utils/businessTime');
const {
  computeAndStoreDailySummary,
  ROUTE_ALGORITHM_VERSION
} = require('../src/geo/services/dailyRouteSummary.service');

const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force');
const companyArg = process.argv.find((a) => a.startsWith('--company='));
const companyFilterId = companyArg ? companyArg.split('=')[1] : null;
const daysArg = process.argv.find((a) => a.startsWith('--days='));
const backDays = daysArg ? Math.max(1, Number(daysArg.split('=')[1]) || 90) : 90;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected. mode=${apply ? 'APPLY' : 'DRY-RUN'} days=${backDays}`);

  const companyQuery = { isDeleted: { $ne: true } };
  if (companyFilterId) companyQuery._id = new mongoose.Types.ObjectId(companyFilterId);
  const companies = await Company.find(companyQuery)
    .select('_id name geoPlatform liveTrackingEnabled timeZone')
    .lean();

  let computed = 0;
  let skipped = 0;
  let failed = 0;

  for (const company of companies) {
    let tz;
    try {
      tz = businessTime.requireCompanyIanaZone(company.timeZone);
    } catch {
      console.log(`- ${company.name}: no timezone configured, skipping`);
      continue;
    }

    const todayYmd = businessTime.nowInBusinessTime(tz).toISODate();
    const since = new Date(Date.now() - backDays * 24 * 60 * 60 * 1000);
    const cid = new mongoose.Types.ObjectId(String(company._id));

    // Distinct (user, business-day) pairs with data in the window.
    const pairs = await AttendanceHeartbeat.aggregate([
      { $match: { companyId: cid, capturedAt: { $gte: since } } },
      {
        $group: {
          _id: {
            userId: '$userId',
            ymd: {
              $dateToString: { format: '%Y-%m-%d', date: '$capturedAt', timezone: tz }
            }
          },
          points: { $sum: 1 }
        }
      },
      { $sort: { '_id.ymd': 1 } }
    ]);

    console.log(`- ${company.name}: ${pairs.length} user-days`);

    const existing = force
      ? new Set()
      : new Set(
          (
            await DailyRouteSummary.find({
              companyId: cid,
              dirty: { $ne: true },
              algorithmVersion: ROUTE_ALGORITHM_VERSION
            })
              .select('userId date')
              .lean()
          ).map((r) => `${r.userId}_${r.date}`)
        );

    for (const pair of pairs) {
      const { userId, ymd } = pair._id;
      if (ymd >= todayYmd) continue; // never materialize the in-progress day
      if (existing.has(`${userId}_${ymd}`)) {
        skipped += 1;
        continue;
      }
      if (!apply) {
        computed += 1;
        continue;
      }
      try {
        await computeAndStoreDailySummary(company._id, userId, ymd, tz, company);
        computed += 1;
      } catch (err) {
        failed += 1;
        console.error(`  ! ${userId} ${ymd}: ${err.message}`);
      }
    }
  }

  console.log(
    `${apply ? 'Computed' : 'Would compute'} ${computed}, skipped ${skipped} (fresh), failed ${failed}`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
