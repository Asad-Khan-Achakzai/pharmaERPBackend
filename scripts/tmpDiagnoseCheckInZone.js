/* Read-only diagnostic: why do V2 check-ins report OUT_OF_ZONE?
 * Usage: node scripts/tmpDiagnoseCheckInZone.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const { distanceMeters } = require('../src/services/geoFence.service');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const companies = await db
    .collection('companies')
    .find(
      { isDeleted: { $ne: true } },
      { projection: { name: 1, attendanceSystemMode: 1, checkInPolicy: 1, timeZone: 1 } }
    )
    .toArray();

  console.log('=== COMPANIES ===');
  for (const c of companies) {
    console.log(
      JSON.stringify({
        id: String(c._id),
        name: c.name,
        mode: c.attendanceSystemMode || null,
        checkInPolicy: c.checkInPolicy || null
      })
    );
  }

  console.log('\n=== WEEKLY PLAN STATUS DISTRIBUTION (last 60 days) ===');
  const cutoff = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  const planStats = await db
    .collection('weeklyplans')
    .aggregate([
      { $match: { createdAt: { $gte: cutoff }, isDeleted: { $ne: true } } },
      {
        $group: {
          _id: { status: '$status', hasCp: { $gt: [{ $size: { $objectToArray: { $ifNull: ['$cpByDay', {}] } } }, 0] } },
          n: { $sum: 1 }
        }
      }
    ])
    .toArray();
  console.log(JSON.stringify(planStats, null, 1));

  console.log('\n=== RECENT V2 CHECK-INS WITH ZONE STATUS (last 30 days, sample 25) ===');
  const cutoff30 = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const rows = await db
    .collection('attendances')
    .find(
      {
        createdAt: { $gte: cutoff30 },
        attendanceLocationStatus: { $in: ['WITHIN_ZONE', 'OUT_OF_ZONE'] },
        isDeleted: { $ne: true }
      },
      {
        projection: {
          companyId: 1,
          employeeId: 1,
          date: 1,
          checkInLat: 1,
          checkInLng: 1,
          checkInAccuracy: 1,
          attendanceLocationStatus: 1,
          distanceFromCheckInPoint: 1,
          resolvedCheckInPolicy: 1,
          requiredCheckInLocation: 1
        }
      }
    )
    .sort({ createdAt: -1 })
    .limit(25)
    .toArray();

  const statusCounts = await db
    .collection('attendances')
    .aggregate([
      { $match: { createdAt: { $gte: cutoff30 }, isDeleted: { $ne: true } } },
      { $group: { _id: '$attendanceLocationStatus', n: { $sum: 1 } } }
    ])
    .toArray();
  console.log('status counts (30d):', JSON.stringify(statusCounts));

  for (const r of rows) {
    const p = r.resolvedCheckInPolicy || {};
    const recomputed =
      typeof r.checkInLat === 'number' && typeof p.latitude === 'number'
        ? Math.round(distanceMeters(p.latitude, p.longitude, r.checkInLat, r.checkInLng))
        : null;
    console.log(
      JSON.stringify({
        att: String(r._id),
        company: String(r.companyId),
        employee: String(r.employeeId),
        date: r.date,
        status: r.attendanceLocationStatus,
        storedDistance: r.distanceFromCheckInPoint,
        recomputedDistance: recomputed,
        policyType: p.type || null,
        policyName: p.locationName || null,
        policyLat: p.latitude ?? null,
        policyLng: p.longitude ?? null,
        policyRadius: p.radiusMeters ?? null,
        userLat: r.checkInLat ?? null,
        userLng: r.checkInLng ?? null,
        accuracy: r.checkInAccuracy ?? null
      })
    );
  }

  console.log('\n=== CP MASTER SAMPLE ===');
  const cps = await db
    .collection('callpoints')
    .find({}, { projection: { name: 1, latitude: 1, longitude: 1, isActive: 1, companyId: 1 } })
    .limit(10)
    .toArray();
  for (const cp of cps) {
    console.log(
      JSON.stringify({
        id: String(cp._id),
        company: String(cp.companyId),
        name: cp.name,
        lat: cp.latitude,
        lng: cp.longitude,
        latType: typeof cp.latitude,
        lngType: typeof cp.longitude,
        isActive: cp.isActive
      })
    );
  }

  console.log('\n=== WEEKLY PLANS WITH cpByDay (sample 10) ===');
  const cpPlans = await db
    .collection('weeklyplans')
    .find(
      { cpByDay: { $exists: true, $ne: null }, isDeleted: { $ne: true } },
      { projection: { medicalRepId: 1, companyId: 1, status: 1, weekStartDate: 1, weekEndDate: 1, cpByDay: 1 } }
    )
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();
  for (const p of cpPlans) {
    console.log(
      JSON.stringify({
        id: String(p._id),
        company: String(p.companyId),
        rep: String(p.medicalRepId),
        status: p.status,
        weekStart: p.weekStartDate,
        weekEnd: p.weekEndDate,
        cpByDay: Object.fromEntries(
          Object.entries(p.cpByDay || {}).map(([k, v]) => [k, v ? String(v) : null])
        )
      })
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('diagnostic failed:', err.message);
  process.exit(1);
});
