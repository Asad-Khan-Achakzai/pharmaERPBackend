/**
 * Integration-style tests for getRouteHistory: a realistic business day is fed
 * through the real cleaning/segmentation pipeline (routeProcessing, gpsQuality,
 * businessTime are all real) with only the Mongo models stubbed. Verifies the
 * response contract the mobile/web clients depend on: timeSegments, stops vs
 * gaps, teleport rejection, distance from movement segments, doctor
 * association and company-timezone dates.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Model stubs (registered before routeHistory.service is required).
// ---------------------------------------------------------------------------

function preloadStub(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports
  };
}

/** Chainable no-op query mock resolving to `result()` at .lean(). */
function query(result) {
  const chain = {
    sort: () => chain,
    select: () => chain,
    limit: () => chain,
    lean: () => Promise.resolve(result())
  };
  return chain;
}

const db = {
  heartbeats: [],
  attendance: null,
  visits: [],
  doctors: []
};

preloadStub('../../models/AttendanceHeartbeat', { find: () => query(() => db.heartbeats) });
preloadStub('../../models/Attendance', { findOne: () => query(() => db.attendance) });
preloadStub('../../models/VisitLog', { find: () => query(() => db.visits) });
preloadStub('../../models/TrackingDiagnostic', { find: () => query(() => []) });
preloadStub('../../models/Doctor', { find: () => query(() => db.doctors) });
preloadStub('../../models/Pharmacy', { find: () => query(() => []) });
preloadStub('../../models/CallPoint', { find: () => query(() => []) });
preloadStub('../../models/Order', { find: () => query(() => []) });
preloadStub('../../models/MediaAsset', { aggregate: async () => [] });
preloadStub('../../models/User', { findOne: () => query(() => ({ territoryId: null })) });
preloadStub('./dayRoute.service', {
  async getDayRoute() {
    return null;
  }
});

const routeHistoryService = require('./routeHistory.service');

// ---------------------------------------------------------------------------
// Fixture: 2026-08-10 in Asia/Karachi (UTC+5). All capturedAt in UTC.
//
//  04:00–04:10Z  movement A→B   (0.002° lat/min ≈ 222 m/min, ~3.7 m/s)
//  04:11–04:25Z  stop at B      (15 min dwell, ±11 m jitter)
//  04:15:30Z     teleport       (single 700 km bogus fix — must be rejected)
//  04:26–04:30Z  movement B→C
//  04:30–05:15Z  GPS gap        (45 min of missing data — never a stop)
//  05:15–05:20Z  movement C→D
// ---------------------------------------------------------------------------

const COMPANY_ID = '64b000000000000000000001';
const USER_ID = '64b000000000000000000002';
const TZ = 'Asia/Karachi';
const DAY = '2026-08-10';
const BASE_MS = Date.UTC(2026, 7, 10, 4, 0, 0);

function hb(minute, lat, lng, extra = {}) {
  return {
    lat,
    lng,
    accuracy: 10,
    confidence: 80,
    qualityLevel: 'good',
    usableForLive: true,
    speed: null,
    heading: null,
    source: 'background',
    capturedAt: new Date(BASE_MS + minute * 60_000),
    ...extra
  };
}

function buildDayFixture() {
  const points = [];
  // Movement leg 1: A (31.500) → B (31.520)
  for (let m = 0; m <= 10; m += 1) points.push(hb(m, 31.5 + 0.002 * m, 74.35));
  // Stop at B with small jitter
  for (let m = 11; m <= 25; m += 1) {
    points.push(hb(m, 31.52 + (m % 2 === 0 ? 0.0001 : 0), 74.35));
  }
  // Bogus teleport 30s after the 04:15 sample: ~700 km away in an instant
  points.push(hb(15.5, 36.0, 80.0));
  // Movement leg 2: B → C (31.528)
  for (let m = 26; m <= 30; m += 1) points.push(hb(m, 31.52 + 0.002 * (m - 25), 74.35));
  // 45-minute gap, then movement leg 3: C → D (31.538)
  for (let m = 75; m <= 80; m += 1) points.push(hb(m, 31.528 + 0.002 * (m - 75), 74.35));
  points.sort((a, b) => a.capturedAt - b.capturedAt);
  return points;
}

const DOCTOR_ID = '64b0000000000000000000d1';

function seedRealisticDay() {
  db.heartbeats = buildDayFixture();
  db.attendance = {
    checkInTime: new Date(BASE_MS - 5 * 60_000),
    checkInLat: 31.5,
    checkInLng: 74.35,
    checkOutTime: new Date(BASE_MS + 85 * 60_000),
    checkOutLat: 31.538,
    checkOutLng: 74.35
  };
  db.visits = [
    {
      _id: '64b0000000000000000000e1',
      location: { lat: 31.52, lng: 74.35 },
      visitTime: new Date(BASE_MS + 12 * 60_000),
      createdAt: new Date(BASE_MS + 12 * 60_000),
      checkInTime: new Date(BASE_MS + 12 * 60_000),
      checkOutTime: new Date(BASE_MS + 24 * 60_000),
      doctorId: DOCTOR_ID,
      distanceFromDoctor: 8,
      geoFenceResult: 'INSIDE',
      notes: '',
      orderTaken: false,
      planItemId: null
    }
  ];
  db.doctors = [{ _id: DOCTOR_ID, name: 'Dr. Test', latitude: 31.52, longitude: 74.35 }];
}

describe('getRouteHistory (integration, stubbed models)', () => {
  it('returns company-timezone dates and the documented payload shape', async () => {
    seedRealisticDay();
    const res = await routeHistoryService.getRouteHistory(COMPANY_ID, USER_ID, DAY, TZ);

    assert.equal(res.date, DAY);
    assert.equal(res.companyDate, DAY);
    assert.equal(res.timeZone, TZ);
    assert.equal(res.userId, USER_ID);
    assert.ok(Array.isArray(res.timeSegments));
    assert.ok(Array.isArray(res.stops));
    assert.ok(Array.isArray(res.gaps));
    assert.ok(res.pointStats && typeof res.pointStats.rawPointCount === 'number');
  });

  it('rejects the teleport point and keeps distance to real movement only', async () => {
    seedRealisticDay();
    const res = await routeHistoryService.getRouteHistory(COMPANY_ID, USER_ID, DAY, TZ);

    assert.ok(res.pointStats.removedOutliers >= 1, 'teleport must be counted as outlier');
    // Real movement ≈ 2.2 km + 0.9 km + 1.1 km. A single accepted teleport
    // would add ~1,400 km round trip.
    assert.ok(
      res.summary.distanceMeters > 3000 && res.summary.distanceMeters < 6500,
      `distance ${res.summary.distanceMeters}m out of realistic range`
    );
  });

  it('represents the 45-minute silence as a gap segment, never a stop', async () => {
    seedRealisticDay();
    const res = await routeHistoryService.getRouteHistory(COMPANY_ID, USER_ID, DAY, TZ);

    const gapSegments = res.timeSegments.filter((s) => s.type === 'gap');
    assert.ok(
      gapSegments.some((s) => s.durationMs >= 40 * 60_000),
      'expected a ~45-minute gap segment'
    );
    for (const stop of res.stops) {
      assert.ok(
        stop.durationMs < 20 * 60_000,
        `no stop may absorb the gap (got ${Math.round(stop.durationMs / 60000)}min)`
      );
    }
    assert.ok(
      res.gaps.some((g) => g.type === 'SIGNAL_GAP' && g.durationMs >= 40 * 60_000),
      'gap list must include the signal gap'
    );
  });

  it('detects the doctor stop and associates the visit', async () => {
    seedRealisticDay();
    const res = await routeHistoryService.getRouteHistory(COMPANY_ID, USER_ID, DAY, TZ);

    assert.equal(res.stops.length, 1);
    const stop = res.stops[0];
    assert.ok(stop.durationMs >= 10 * 60_000 && stop.durationMs <= 16 * 60_000);
    assert.equal(stop.classification, 'Doctor Visit');
    assert.equal(stop.kind, 'doctor');

    assert.equal(res.visits.length, 1);
    assert.equal(res.visits[0].doctorName, 'Dr. Test');
  });

  it('never draws a movement polyline across the gap', async () => {
    seedRealisticDay();
    const res = await routeHistoryService.getRouteHistory(COMPANY_ID, USER_ID, DAY, TZ);

    const gap = res.timeSegments.find(
      (s) => s.type === 'gap' && s.durationMs >= 40 * 60_000
    );
    assert.ok(gap);
    const gapFrom = new Date(gap.fromCapturedAt).getTime();
    const gapTo = new Date(gap.toCapturedAt).getTime();
    for (const seg of res.timeSegments.filter((s) => s.type === 'movement')) {
      const from = new Date(seg.fromCapturedAt).getTime();
      const to = new Date(seg.toCapturedAt).getTime();
      assert.ok(
        to <= gapFrom || from >= gapTo,
        'movement segment must not span the gap'
      );
    }
  });

  it('handles an empty day without errors', async () => {
    db.heartbeats = [];
    db.attendance = null;
    db.visits = [];
    db.doctors = [];
    const res = await routeHistoryService.getRouteHistory(COMPANY_ID, USER_ID, DAY, TZ);

    assert.deepEqual(res.path, []);
    assert.deepEqual(res.timeSegments, []);
    assert.deepEqual(res.stops, []);
    assert.equal(res.summary.distanceMeters, 0);
    assert.equal(res.summary.stopCount, 0);
  });
});
