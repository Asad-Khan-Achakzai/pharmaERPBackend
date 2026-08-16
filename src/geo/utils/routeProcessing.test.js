const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanRoutePoints,
  filterPlausibleTimestamps,
  collapseNearDuplicates,
  rejectTeleports,
  detectConflictingSources,
  buildTimeSegments,
  simplifyPath,
  pathDistanceM,
} = require('./routeProcessing');

const T0 = new Date('2026-08-03T09:00:00Z').getTime();
const at = (mins, secs = 0) => new Date(T0 + mins * 60_000 + secs * 1000);

/** ~1 degree lat ≈ 111.32 km; 0.00009 ≈ 10m. */
const pt = (lat, lng, minutes, extra = {}) => ({
  lat,
  lng,
  accuracy: 15,
  capturedAt: at(minutes),
  ...extra,
});

// Quetta, Pakistan vs bogus second source (Changsha, China) — real production pattern.
const QUETTA = { lat: 30.1975, lng: 67.0128 };
const CHINA = { lat: 28.1918, lng: 113.2236 };

test('filterPlausibleTimestamps excludes future and invalid points, keeps raw capturedAt', () => {
  const now = at(60).getTime();
  const future = pt(30.1, 67.0, 90);
  const invalidDate = { lat: 30.1, lng: 67.0, capturedAt: 'not-a-date' };
  const nullIsland = pt(0, 0, 10);
  const good = pt(30.1, 67.0, 10);
  const { points, excluded } = filterPlausibleTimestamps(
    [good, future, invalidDate, nullIsland],
    { nowMs: now }
  );
  assert.equal(points.length, 1);
  assert.equal(excluded, 3);
  assert.equal(points[0].capturedAt, good.capturedAt); // untouched
});

test('collapseNearDuplicates removes <8m/<30s repeats only', () => {
  const base = pt(30.19750, 67.01280, 0);
  const dup = { ...pt(30.19752, 67.01281, 0), capturedAt: at(0, 10) }; // ~3m, 10s
  const later = { ...pt(30.19752, 67.01281, 0), capturedAt: at(2) }; // same spot, 2min → kept
  const moved = pt(30.19850, 67.01280, 3); // ~110m → kept
  const { points, removed } = collapseNearDuplicates([base, dup, later, moved]);
  assert.equal(removed, 1);
  assert.equal(points.length, 3);
});

test('rejectTeleports rejects single bogus jumps (real Quetta→China case)', () => {
  const points = [
    pt(QUETTA.lat, QUETTA.lng, 0),
    pt(QUETTA.lat + 0.0002, QUETTA.lng, 1),
    pt(CHINA.lat, CHINA.lng, 1, { capturedAt: at(1, 2) }), // 4,460 km in 2s
    pt(QUETTA.lat + 0.0004, QUETTA.lng, 2),
  ];
  const { points: accepted, rejected } = rejectTeleports(points);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].lat, CHINA.lat);
  assert.equal(accepted.length, 3);
  assert.ok(accepted.every((p) => Math.abs(p.lat - QUETTA.lat) < 0.01));
});

test('rejectTeleports re-anchors after 2 consistent points at a new location', () => {
  // Genuine relocation: tracker resumed 100km away with plausible follow-up points.
  const farLat = QUETTA.lat + 0.9; // ~100km north
  const points = [
    pt(QUETTA.lat, QUETTA.lng, 0),
    pt(farLat, QUETTA.lng, 10), // 100km in 10min = 167 m/s → impossible hop
    pt(farLat + 0.0002, QUETTA.lng, 11),
    pt(farLat + 0.0004, QUETTA.lng, 12),
  ];
  const { points: accepted, rejected, discontinuities } = rejectTeleports(points);
  assert.equal(rejected.length, 0);
  assert.equal(discontinuities, 1);
  assert.equal(accepted.length, 4);
  assert.equal(accepted[1].discontinuity, true);
});

test('rejectTeleports accepts legit highway driving (39 m/s observed max)', () => {
  // 2,366m in 60s = 39.4 m/s — real production hop, must be accepted.
  const points = [
    pt(30.0000, 67.0000, 0),
    pt(30.0213, 67.0000, 1), // ~2,370m in 60s
    pt(30.0420, 67.0000, 2),
  ];
  const { rejected } = rejectTeleports(points);
  assert.equal(rejected.length, 0);
});

test('detectConflictingSources flags recurring second cluster', () => {
  const rejected = Array.from({ length: 6 }, (_, i) =>
    pt(CHINA.lat + i * 0.0001, CHINA.lng, i)
  );
  const conflict = detectConflictingSources(rejected, 0);
  assert.equal(conflict.detected, true);
  assert.equal(conflict.reason, 'rejected_cluster');
  assert.ok(conflict.clusterSize >= 5);
});

test('detectConflictingSources flags repeated re-anchoring flips', () => {
  const conflict = detectConflictingSources([], 4);
  assert.equal(conflict.detected, true);
  assert.equal(conflict.reason, 'repeated_reanchoring');
});

test('full-day oscillation ABAB: bogus source fully rejected, conflict detected', () => {
  const points = [];
  for (let m = 0; m < 60; m += 2) {
    points.push(pt(QUETTA.lat + m * 0.00001, QUETTA.lng, m));
    points.push(pt(CHINA.lat, CHINA.lng, m + 1));
  }
  const result = cleanRoutePoints(points, { nowMs: at(120).getTime() });
  assert.ok(result.rejectedOutliers >= 25);
  assert.equal(result.conflictingSources.detected, true);
  assert.ok(result.points.every((p) => Math.abs(p.lat - QUETTA.lat) < 0.01));
});

test('gap never becomes a stop: 09:00 → 09:02 → 10:00 yields movement + gap', () => {
  const points = [
    pt(30.1000, 67.0000, 0),
    pt(30.1010, 67.0000, 2),
    pt(30.1010, 67.0001, 60), // 58min later, same place
    pt(30.1011, 67.0001, 62),
  ];
  const { segments, stops } = buildTimeSegments(points, { gapThresholdMs: 5 * 60_000 });
  const gap = segments.find((s) => s.type === 'gap');
  assert.ok(gap, 'expected a gap segment');
  assert.ok(gap.durationMs >= 57 * 60_000);
  assert.equal(gap.reason, 'SIGNAL_GAP');
  // No stop may claim the 58 minutes of missing data.
  assert.ok(stops.every((s) => s.durationMs < 10 * 60_000));
});

test('stop detection: 45min dwell with GPS jitter detected as one stop', () => {
  const points = [];
  // Drive in (5 points over 4 min)
  for (let m = 0; m <= 4; m += 1) points.push(pt(30.1 + (4 - m) * 0.001, 67.0, m));
  // Dwell 45 min with ±20m jitter every minute
  for (let m = 5; m <= 50; m += 1) {
    points.push(pt(30.1 + (m % 3) * 0.00012, 67.0 + (m % 2) * 0.0001, m));
  }
  // Drive off
  for (let m = 51; m <= 55; m += 1) points.push(pt(30.1 + (m - 50) * 0.001, 67.0, m));
  const { segments, stops, stationaryTimeMs } = buildTimeSegments(points, {
    gapThresholdMs: 5 * 60_000,
  });
  assert.equal(stops.length, 1);
  assert.ok(stops[0].durationMs >= 40 * 60_000, `dwell was ${stops[0].durationMs}`);
  assert.ok(stationaryTimeMs >= 40 * 60_000);
  assert.equal(segments.filter((s) => s.type === 'movement').length, 2);
});

test('stop merge respects visit boundary (same-plaza clinics stay separate)', () => {
  const points = [];
  // Dwell A at 30.1000 for 7 min
  for (let m = 0; m <= 7; m += 1) points.push(pt(30.1000, 67.0, m));
  // Brief excursion ~150m away (3 points, 20s apart → overflows tolerance of 2)
  points.push({ ...pt(30.10135, 67.0, 7), capturedAt: at(7, 20) });
  points.push({ ...pt(30.10135, 67.0, 7), capturedAt: at(7, 40) });
  points.push({ ...pt(30.10136, 67.0, 8), capturedAt: at(8, 0) });
  // Dwell B ~33m from A, starting 80s after A ended
  points.push({ ...pt(30.1003, 67.0, 8), capturedAt: at(8, 20) });
  points.push({ ...pt(30.1003, 67.0, 8), capturedAt: at(8, 40) });
  for (let m = 9; m <= 15; m += 1) points.push(pt(30.1003, 67.0, m));

  const noBoundary = buildTimeSegments(points, { gapThresholdMs: 5 * 60_000 });
  assert.equal(noBoundary.stops.length, 1, 'merged without a visit boundary');

  const boundary = buildTimeSegments(points, {
    gapThresholdMs: 5 * 60_000,
    visitBoundaryMs: [at(7, 50).getTime()],
  });
  assert.equal(boundary.stops.length, 2, 'kept separate across a visit boundary');
});

test('distance comes from movement segments only (stops and gaps contribute 0)', () => {
  const points = [];
  // Move 1km over 5 min (~200m/min)
  for (let m = 0; m <= 5; m += 1) points.push(pt(30.1 + m * 0.0018, 67.0, m));
  // Dwell with jitter 10 min (~15m wobble)
  for (let m = 6; m <= 16; m += 1) points.push(pt(30.109 + (m % 2) * 0.00013, 67.0, m));
  // Gap then far away (genuine relocation covered by discontinuity? no — 20min gap, 2km → 1.7m/s)
  points.push(pt(30.127, 67.0, 36));
  points.push(pt(30.1272, 67.0, 37));
  const { segments, distanceMeters } = buildTimeSegments(points, { gapThresholdMs: 5 * 60_000 });
  const movementDist = segments
    .filter((s) => s.type === 'movement')
    .reduce((sum, s) => sum + s.distanceMeters, 0);
  assert.equal(distanceMeters, movementDist);
  // Total must not include the 2km gap chord: raw chained distance would be ~3.2km.
  assert.ok(distanceMeters < 1600, `distance ${distanceMeters} should exclude gap chord`);
});

test('simplifyPath preserves endpoints and corners, distance still from full path', () => {
  const line = [];
  for (let i = 0; i <= 20; i += 1) line.push(pt(30.1 + i * 0.0001, 67.0, i)); // straight
  line.push(pt(30.102, 67.002, 21)); // heading east after the corner
  line.push(pt(30.102, 67.004, 22));
  const simplified = simplifyPath(line, 20);
  assert.ok(simplified.length < line.length);
  assert.equal(simplified[0].lat, line[0].lat);
  assert.equal(simplified[simplified.length - 1].lat, line[line.length - 1].lat);
  // The true corner (top of the northward leg, where direction changes) is retained
  assert.ok(simplified.some((p) => Math.abs(p.lat - 30.102) < 1e-9 && Math.abs(p.lng - 67.0) < 1e-9));
  // Full-res distance is larger or equal to simplified distance
  assert.ok(pathDistanceM(line) >= pathDistanceM(simplified));
});

test('cleanRoutePoints end-to-end counters', () => {
  const points = [
    pt(QUETTA.lat, QUETTA.lng, 0),
    { ...pt(QUETTA.lat, QUETTA.lng, 0), capturedAt: at(0, 5) }, // duplicate
    pt(CHINA.lat, CHINA.lng, 1), // teleport
    pt(QUETTA.lat + 0.0003, QUETTA.lng, 2),
    pt(QUETTA.lat + 0.0006, QUETTA.lng, 90), // future vs nowMs below
  ];
  const result = cleanRoutePoints(points, { nowMs: at(60).getTime() });
  assert.equal(result.rawPointCount, 5);
  assert.equal(result.excludedPoints, 1);
  assert.equal(result.removedDuplicates, 1);
  assert.equal(result.rejectedOutliers, 1);
  assert.equal(result.points.length, 2);
});
