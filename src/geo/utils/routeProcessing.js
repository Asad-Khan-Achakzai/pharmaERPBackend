/**
 * GPS route processing pipeline for Route History.
 *
 * Raw AttendanceHeartbeat rows are never mutated — every step here operates
 * in memory on a copy of the day's points so history can always be
 * reprocessed from raw data when thresholds change.
 *
 * Pipeline: sort → timestamp plausibility → near-duplicate collapse →
 * teleport rejection (with re-anchoring + conflicting-source detection) →
 * typed time segments (movement | stop | gap) → distance/durations.
 *
 * Threshold rationale (validated against production data, Aug 2026):
 * - Legit field-rep driving tops out ~39 m/s; bogus dual-device/mock-GPS
 *   hops are 5+ orders of magnitude faster → 45 m/s max speed.
 * - Bogus fixes can report excellent accuracy, so accuracy is NOT used as
 *   a teleport signal. Device-reported speed reads 0 while driving, so it
 *   is never used for validation either.
 * - Doctors commonly share plazas (200 pairs < 30m apart) → stop merging is
 *   conservative and never crosses a visit check-in/out boundary.
 */

const { haversineMeters } = require('../../utils/haversine');

/**
 * Bump when any cleaning/segmentation threshold or algorithm changes so
 * materialized DailyRouteSummary rows recompute on next read.
 */
const ROUTE_ALGORITHM_VERSION = 1;

const DEFAULT_MAX_SPEED_MPS = 45;
const DEFAULT_MIN_DISPLACEMENT_M = 200;
const DEFAULT_REANCHOR_COUNT = 2;
const DEFAULT_DUPLICATE_RADIUS_M = 8;
const DEFAULT_DUPLICATE_WINDOW_MS = 30_000;
const DEFAULT_FUTURE_TOLERANCE_MS = 2 * 60 * 1000;
const DEFAULT_STOP_RADIUS_M = 60;
const DEFAULT_STOP_DWELL_MS = 5 * 60 * 1000;
const DEFAULT_EXCURSION_TOLERANCE = 2;
const DEFAULT_MERGE_RADIUS_M = 60;
const DEFAULT_MERGE_GAP_MS = 2 * 60 * 1000;
const DEFAULT_SIMPLIFY_EPSILON_M = 20;
const CONFLICT_CLUSTER_RADIUS_M = 500;
const CONFLICT_MIN_REJECTIONS = 5;
const CONFLICT_MIN_DISCONTINUITIES = 4;

const toMs = (v) => {
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
};

/** Chronological sort by capturedAt (stable for equal timestamps). */
function sortPoints(points) {
  return [...points]
    .map((p, idx) => ({ p, idx, t: toMs(p.capturedAt) }))
    .sort((a, b) => a.t - b.t || a.idx - b.idx)
    .map((x) => x.p);
}

/**
 * Exclude points whose capturedAt is invalid or implausibly in the future.
 * Raw capturedAt values are never modified.
 */
function filterPlausibleTimestamps(points, { nowMs = Date.now(), futureToleranceMs = DEFAULT_FUTURE_TOLERANCE_MS } = {}) {
  const kept = [];
  let excluded = 0;
  for (const p of points) {
    const t = toMs(p.capturedAt);
    if (!Number.isFinite(t) || t > nowMs + futureToleranceMs) {
      excluded += 1;
      continue;
    }
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number' ||
        !Number.isFinite(p.lat) || !Number.isFinite(p.lng) ||
        Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 ||
        (Math.abs(p.lat) < 0.0001 && Math.abs(p.lng) < 0.0001)) {
      excluded += 1;
      continue;
    }
    kept.push(p);
  }
  return { points: kept, excluded };
}

/** Collapse near-identical consecutive points (<8m within 30s). */
function collapseNearDuplicates(points, { radiusM = DEFAULT_DUPLICATE_RADIUS_M, windowMs = DEFAULT_DUPLICATE_WINDOW_MS } = {}) {
  if (points.length < 2) return { points: [...points], removed: 0 };
  const kept = [points[0]];
  let removed = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = kept[kept.length - 1];
    const curr = points[i];
    const dt = toMs(curr.capturedAt) - toMs(prev.capturedAt);
    if (dt < windowMs && haversineMeters(prev.lat, prev.lng, curr.lat, curr.lng) < radiusM) {
      removed += 1;
      continue;
    }
    kept.push(curr);
  }
  return { points: kept, removed };
}

/**
 * Reject physically impossible hops (teleports).
 *
 * A candidate is rejected when implied speed from the last ACCEPTED point
 * exceeds maxSpeedMps AND displacement exceeds minDisplacementM. When
 * `reanchorCount` consecutive rejected points are mutually consistent, they
 * are accepted as a genuine relocation: the first re-anchored point is
 * flagged `discontinuity: true` so segment building treats the hop into it
 * as a gap (no polyline chord, no distance).
 */
function rejectTeleports(points, {
  maxSpeedMps = DEFAULT_MAX_SPEED_MPS,
  minDisplacementM = DEFAULT_MIN_DISPLACEMENT_M,
  reanchorCount = DEFAULT_REANCHOR_COUNT,
} = {}) {
  const accepted = [];
  const rejected = [];
  let discontinuities = 0;
  let buffer = [];

  const isImpossible = (from, to) => {
    const dt = Math.max(toMs(to.capturedAt) - toMs(from.capturedAt), 1000);
    const dist = haversineMeters(from.lat, from.lng, to.lat, to.lng);
    return dist > minDisplacementM && dist / (dt / 1000) > maxSpeedMps;
  };

  for (const p of points) {
    const anchor = accepted[accepted.length - 1];
    if (!anchor) {
      accepted.push(p);
      continue;
    }
    if (!isImpossible(anchor, p)) {
      if (buffer.length) {
        rejected.push(...buffer);
        buffer = [];
      }
      accepted.push(p);
      continue;
    }
    // Impossible vs anchor — candidate for rejection or re-anchor.
    if (buffer.length && isImpossible(buffer[buffer.length - 1], p)) {
      // Not even consistent with the pending cluster — flush and restart.
      rejected.push(...buffer);
      buffer = [p];
      continue;
    }
    buffer.push(p);
    if (buffer.length >= reanchorCount) {
      // Consistent new location — treat as genuine relocation.
      const first = { ...buffer[0], discontinuity: true };
      accepted.push(first, ...buffer.slice(1));
      discontinuities += 1;
      buffer = [];
    }
  }
  rejected.push(...buffer);

  return { points: accepted, rejected, discontinuities };
}

/**
 * Detect a recurring second location source (dual device / mock GPS):
 * rejected points forming a coherent cluster, or repeated re-anchor flips.
 */
function detectConflictingSources(rejected, discontinuities, {
  clusterRadiusM = CONFLICT_CLUSTER_RADIUS_M,
  minRejections = CONFLICT_MIN_REJECTIONS,
  minDiscontinuities = CONFLICT_MIN_DISCONTINUITIES,
} = {}) {
  if (discontinuities >= minDiscontinuities) {
    return { detected: true, reason: 'repeated_reanchoring', clusterSize: discontinuities };
  }
  if (rejected.length < minRejections) return { detected: false };

  const clusters = [];
  for (const p of rejected) {
    let found = null;
    for (const c of clusters) {
      if (haversineMeters(c.lat, c.lng, p.lat, p.lng) <= clusterRadiusM) {
        found = c;
        break;
      }
    }
    if (found) {
      found.n += 1;
      found.lat += (p.lat - found.lat) / found.n;
      found.lng += (p.lng - found.lng) / found.n;
    } else {
      clusters.push({ lat: p.lat, lng: p.lng, n: 1 });
    }
  }
  const biggest = clusters.sort((a, b) => b.n - a.n)[0];
  if (biggest && biggest.n >= minRejections) {
    return {
      detected: true,
      reason: 'rejected_cluster',
      clusterSize: biggest.n,
      lat: Math.round(biggest.lat * 1e5) / 1e5,
      lng: Math.round(biggest.lng * 1e5) / 1e5,
    };
  }
  return { detected: false };
}

/** Perpendicular distance (meters) from point to segment AB via equirectangular projection. */
function perpendicularDistanceM(pt, a, b) {
  const latRad = (a.lat * Math.PI) / 180;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(latRad);
  const ax = a.lng * mPerDegLng; const ay = a.lat * mPerDegLat;
  const bx = b.lng * mPerDegLng; const by = b.lat * mPerDegLat;
  const px = pt.lng * mPerDegLng; const py = pt.lat * mPerDegLat;
  const dx = bx - ax; const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Douglas-Peucker simplification (iterative). Rendering only — never for distance. */
function simplifyPath(points, epsilonM = DEFAULT_SIMPLIFY_EPSILON_M) {
  if (points.length <= 2) return [...points];
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDist = 0;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i += 1) {
      const d = perpendicularDistanceM(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist > epsilonM && maxIdx > 0) {
      keep[maxIdx] = true;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function pathDistanceM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversineMeters(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  return total;
}

/**
 * Centroid-based stop clustering within one gap-free run of points.
 * Dwell counts only continuously sampled time (runs are already gap-free),
 * so a data gap can never be reported as a stop.
 * `low_confidence` points join a cluster but do not move its centroid.
 */
function detectStopsInRun(run, {
  radiusM = DEFAULT_STOP_RADIUS_M,
  dwellMs = DEFAULT_STOP_DWELL_MS,
  excursionTolerance = DEFAULT_EXCURSION_TOLERANCE,
} = {}) {
  const clusters = [];
  let current = null;
  let pending = [];

  const centroidWeight = (p) => (p.qualityLevel === 'low_confidence' ? 0 : 1);

  const startCluster = (p, index) => ({
    startIdx: index,
    endIdx: index,
    members: [p],
    wLat: p.lat * centroidWeight(p),
    wLng: p.lng * centroidWeight(p),
    w: centroidWeight(p),
    lat: p.lat,
    lng: p.lng,
  });

  const addMember = (cluster, p, index) => {
    cluster.members.push(p);
    cluster.endIdx = index;
    const w = centroidWeight(p);
    if (w > 0) {
      cluster.wLat += p.lat * w;
      cluster.wLng += p.lng * w;
      cluster.w += w;
      cluster.lat = cluster.wLat / cluster.w;
      cluster.lng = cluster.wLng / cluster.w;
    }
  };

  const finalize = (cluster) => {
    if (!cluster || cluster.members.length < 2) return;
    const startedAt = cluster.members[0].capturedAt;
    const endedAt = cluster.members[cluster.members.length - 1].capturedAt;
    const durationMs = toMs(endedAt) - toMs(startedAt);
    if (durationMs >= dwellMs) {
      clusters.push({
        lat: cluster.w > 0 ? cluster.wLat / cluster.w : cluster.lat,
        lng: cluster.w > 0 ? cluster.wLng / cluster.w : cluster.lng,
        startedAt,
        endedAt,
        durationMs,
        startIdx: cluster.startIdx,
        endIdx: cluster.endIdx,
        pointCount: cluster.members.length,
      });
    }
  };

  let i = 0;
  while (i < run.length) {
    const p = run[i];
    if (!current) {
      current = startCluster(p, i);
      pending = [];
      i += 1;
      continue;
    }
    const dist = haversineMeters(current.lat, current.lng, p.lat, p.lng);
    if (dist <= radiusM) {
      // Point returned inside: absorb any brief excursion into the cluster span.
      for (const ex of pending) addMember(current, ex.p, ex.idx);
      pending = [];
      addMember(current, p, i);
      i += 1;
    } else {
      pending.push({ p, idx: i });
      if (pending.length > excursionTolerance) {
        finalize(current);
        // Restart scanning from the first excursion point.
        i = pending[0].idx;
        current = null;
        pending = [];
      } else {
        i += 1;
      }
    }
  }
  finalize(current);
  return clusters;
}

/**
 * Merge adjacent stops only when they are clearly the same dwell:
 * close centroids, tiny time gap, and no visit check-in/out boundary between
 * them (same-plaza clinics must remain distinct stops).
 */
function mergeAdjacentStops(stops, {
  mergeRadiusM = DEFAULT_MERGE_RADIUS_M,
  mergeGapMs = DEFAULT_MERGE_GAP_MS,
  visitBoundaryMs = [],
} = {}) {
  if (stops.length < 2) return stops;
  const merged = [stops[0]];
  for (let i = 1; i < stops.length; i += 1) {
    const prev = merged[merged.length - 1];
    const curr = stops[i];
    const gap = toMs(curr.startedAt) - toMs(prev.endedAt);
    const dist = haversineMeters(prev.lat, prev.lng, curr.lat, curr.lng);
    const boundaryBetween = visitBoundaryMs.some(
      (b) => b > toMs(prev.endedAt) && b < toMs(curr.startedAt)
    );
    if (dist < mergeRadiusM && gap >= 0 && gap < mergeGapMs && !boundaryBetween) {
      const total = prev.pointCount + curr.pointCount;
      prev.lat = (prev.lat * prev.pointCount + curr.lat * curr.pointCount) / total;
      prev.lng = (prev.lng * prev.pointCount + curr.lng * curr.pointCount) / total;
      prev.endedAt = curr.endedAt;
      prev.endIdx = curr.endIdx;
      prev.durationMs = toMs(prev.endedAt) - toMs(prev.startedAt);
      prev.pointCount = total;
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

const slimPoint = (p) => ({
  lat: p.lat,
  lng: p.lng,
  capturedAt: p.capturedAt,
  accuracy: p.accuracy ?? null,
  qualityLevel: p.qualityLevel ?? null,
});

/**
 * Build typed time segments (movement | stop | gap) from cleaned points.
 * Movement polylines never span a gap or teleport discontinuity, so the map
 * can never draw a straight chord across missing data.
 */
function buildTimeSegments(points, {
  gapThresholdMs,
  stopRadiusM = DEFAULT_STOP_RADIUS_M,
  stopDwellMs = DEFAULT_STOP_DWELL_MS,
  excursionTolerance = DEFAULT_EXCURSION_TOLERANCE,
  mergeRadiusM = DEFAULT_MERGE_RADIUS_M,
  mergeGapMs = DEFAULT_MERGE_GAP_MS,
  visitBoundaryMs = [],
  simplifyEpsilonM = DEFAULT_SIMPLIFY_EPSILON_M,
} = {}) {
  const segments = [];
  const allStops = [];
  if (!points.length) {
    return { segments, stops: allStops, distanceMeters: 0, movingTimeMs: 0, stationaryTimeMs: 0, gapTimeMs: 0 };
  }

  // 1) Split into gap-free runs.
  const runs = [];
  let run = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    const dt = toMs(curr.capturedAt) - toMs(prev.capturedAt);
    if (curr.discontinuity || dt > gapThresholdMs) {
      runs.push({ points: run, gapAfter: { reason: curr.discontinuity ? 'DISCONTINUITY' : 'SIGNAL_GAP' } });
      run = [curr];
    } else {
      run.push(curr);
    }
  }
  runs.push({ points: run, gapAfter: null });

  let distanceMeters = 0;
  let movingTimeMs = 0;
  let stationaryTimeMs = 0;
  let gapTimeMs = 0;

  const pushMovement = (pts) => {
    if (pts.length < 2) return;
    const dist = pathDistanceM(pts);
    const durationMs = toMs(pts[pts.length - 1].capturedAt) - toMs(pts[0].capturedAt);
    if (dist < 1 && durationMs < 1000) return;
    distanceMeters += dist;
    movingTimeMs += durationMs;
    segments.push({
      type: 'movement',
      fromCapturedAt: pts[0].capturedAt,
      toCapturedAt: pts[pts.length - 1].capturedAt,
      durationMs,
      distanceMeters: Math.round(dist),
      pointCount: pts.length,
      path: simplifyPath(pts, simplifyEpsilonM).map(slimPoint),
    });
  };

  for (let r = 0; r < runs.length; r += 1) {
    const { points: rp, gapAfter } = runs[r];
    const stops = mergeAdjacentStops(
      detectStopsInRun(rp, { radiusM: stopRadiusM, dwellMs: stopDwellMs, excursionTolerance }),
      { mergeRadiusM, mergeGapMs, visitBoundaryMs }
    );

    let cursor = 0;
    for (const stop of stops) {
      // Movement leading into the stop (include boundary point for continuity).
      pushMovement(rp.slice(cursor, stop.startIdx + 1));
      stationaryTimeMs += stop.durationMs;
      const stopOut = {
        lat: stop.lat,
        lng: stop.lng,
        startedAt: stop.startedAt,
        endedAt: stop.endedAt,
        durationMs: stop.durationMs,
        pointCount: stop.pointCount,
      };
      allStops.push(stopOut);
      segments.push({
        type: 'stop',
        fromCapturedAt: stop.startedAt,
        toCapturedAt: stop.endedAt,
        durationMs: stop.durationMs,
        lat: stop.lat,
        lng: stop.lng,
        pointCount: stop.pointCount,
      });
      cursor = stop.endIdx;
    }
    pushMovement(rp.slice(cursor));

    if (gapAfter && r + 1 < runs.length) {
      const from = rp[rp.length - 1];
      const to = runs[r + 1].points[0];
      const durationMs = Math.max(0, toMs(to.capturedAt) - toMs(from.capturedAt));
      gapTimeMs += durationMs;
      segments.push({
        type: 'gap',
        reason: gapAfter.reason,
        fromCapturedAt: from.capturedAt,
        toCapturedAt: to.capturedAt,
        durationMs,
        fromLat: from.lat,
        fromLng: from.lng,
        toLat: to.lat,
        toLng: to.lng,
      });
    }
  }

  return {
    segments,
    stops: allStops,
    distanceMeters: Math.round(distanceMeters),
    movingTimeMs: Math.round(movingTimeMs),
    stationaryTimeMs: Math.round(stationaryTimeMs),
    gapTimeMs: Math.round(gapTimeMs),
  };
}

/**
 * Full cleaning pass. Returns cleaned points plus audit counters.
 * Never mutates or persists anything — raw heartbeats stay untouched.
 */
function cleanRoutePoints(rawPoints, options = {}) {
  const sorted = sortPoints(rawPoints);
  const plausible = filterPlausibleTimestamps(sorted, options);
  const deduped = collapseNearDuplicates(plausible.points, options);
  const filtered = rejectTeleports(deduped.points, options);
  const conflict = detectConflictingSources(filtered.rejected, filtered.discontinuities, options);
  return {
    points: filtered.points,
    rawPointCount: rawPoints.length,
    excludedPoints: plausible.excluded,
    removedDuplicates: deduped.removed,
    rejectedOutliers: filtered.rejected.length,
    discontinuities: filtered.discontinuities,
    conflictingSources: conflict,
  };
}

module.exports = {
  ROUTE_ALGORITHM_VERSION,
  cleanRoutePoints,
  sortPoints,
  filterPlausibleTimestamps,
  collapseNearDuplicates,
  rejectTeleports,
  detectConflictingSources,
  detectStopsInRun,
  mergeAdjacentStops,
  buildTimeSegments,
  simplifyPath,
  pathDistanceM,
  DEFAULT_MAX_SPEED_MPS,
  DEFAULT_MIN_DISPLACEMENT_M,
  DEFAULT_STOP_RADIUS_M,
  DEFAULT_STOP_DWELL_MS,
  DEFAULT_SIMPLIFY_EPSILON_M,
};
