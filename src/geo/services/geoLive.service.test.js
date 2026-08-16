/**
 * Integration-style tests for the batch heartbeat ingestion path
 * (recordHeartbeatsBatch). Real modules are used for geo feature resolution,
 * the snapshot quality gate and the rate-limit helpers; only the Mongo-backed
 * modules (liveTracking.service, RepLocationSnapshot, RealtimeHub) are stubbed
 * so the per-point status contract can be exercised without a database.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ApiError = require('../../utils/ApiError');

// ---------------------------------------------------------------------------
// Module stubs (must be registered before geoLive.service is required).
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

const state = {
  received: [], // beats passed to liveTracking.recordHeartbeat, in call order
  snapshotUpserts: [],
  published: []
};

preloadStub('../../services/liveTracking.service', {
  async recordHeartbeat(params) {
    state.received.push(params);
    const uuid = String(params.clientUuid || '');
    if (uuid.startsWith('badgps')) {
      const err = new ApiError(422, 'GPS accuracy invalid');
      err.code = 'GPS_ACCURACY_INVALID';
      throw err;
    }
    if (uuid.startsWith('nostate')) {
      const err = new ApiError(400, 'No active attendance');
      err.code = 'NO_ACTIVE_ATTENDANCE';
      throw err;
    }
    if (uuid.startsWith('malformed')) {
      throw new ApiError(400, 'lat and lng are required');
    }
    if (uuid.startsWith('boom')) {
      throw new ApiError(500, 'database unavailable');
    }
    const doc = {
      lat: params.lat,
      lng: params.lng,
      accuracy: params.accuracy ?? 10,
      confidence: 80,
      qualityLevel: uuid.startsWith('history') ? 'low_confidence' : 'good',
      usableForLive: !uuid.startsWith('history'),
      capturedAt: params.capturedAt,
      expectedNextPingMs: 60_000
    };
    if (uuid.startsWith('dup')) {
      Object.defineProperty(doc, '__replayed', { value: true, enumerable: false });
    }
    return doc;
  },
  async listLive() {
    return [];
  }
});

preloadStub('../models/RepLocationSnapshot', {
  findOne() {
    return { lean: async () => null };
  },
  async findOneAndUpdate(filter, update) {
    state.snapshotUpserts.push({ filter, update });
    return { ...filter, ...update };
  }
});

preloadStub('../../realtime/RealtimeHub', {
  publish(companyId, channel, event) {
    state.published.push({ companyId, channel, event });
  }
});

const geoLiveService = require('./geoLive.service');

// ---------------------------------------------------------------------------

const COMPANY = { _id: '64b000000000000000000001', liveTrackingEnabled: true };
const BASE = {
  companyId: '64b000000000000000000001',
  userId: '64b000000000000000000002',
  company: COMPANY
};

function beat(clientUuid, capturedAt, extra = {}) {
  return {
    clientUuid,
    lat: 31.5,
    lng: 74.35,
    accuracy: 12,
    capturedAt,
    ...extra
  };
}

beforeEach(() => {
  state.received.length = 0;
  state.snapshotUpserts.length = 0;
  state.published.length = 0;
});

describe('recordHeartbeatsBatch per-point statuses', () => {
  it('maps every outcome to a per-point status without failing the batch', async () => {
    const { results, summary } = await geoLiveService.recordHeartbeatsBatch({
      ...BASE,
      heartbeats: [
        beat('ok-1', '2026-08-10T05:00:00.000Z'),
        beat('history-1', '2026-08-10T05:01:00.000Z'),
        beat('dup-1', '2026-08-10T05:02:00.000Z'),
        beat('badgps-1', '2026-08-10T05:03:00.000Z'),
        beat('nostate-1', '2026-08-10T05:04:00.000Z'),
        beat('malformed-1', '2026-08-10T05:05:00.000Z')
      ]
    });

    const byUuid = new Map(results.map((r) => [r.clientUuid, r]));
    assert.equal(byUuid.get('ok-1').status, 'accepted');
    assert.equal(byUuid.get('history-1').status, 'accepted_history_only');
    assert.equal(byUuid.get('dup-1').status, 'rejected_duplicate');
    assert.equal(byUuid.get('badgps-1').status, 'rejected_invalid');
    assert.equal(byUuid.get('nostate-1').status, 'rejected_state');
    assert.equal(byUuid.get('malformed-1').status, 'rejected_invalid');

    assert.deepEqual(summary, {
      accepted: 1,
      acceptedHistoryOnly: 1,
      rejectedInvalid: 2,
      rejectedState: 1,
      rejectedDuplicate: 1,
      total: 6
    });
  });

  it('processes beats in capturedAt order regardless of payload order', async () => {
    await geoLiveService.recordHeartbeatsBatch({
      ...BASE,
      heartbeats: [
        beat('ok-c', '2026-08-10T05:02:00.000Z'),
        beat('ok-a', '2026-08-10T05:00:00.000Z'),
        beat('ok-b', '2026-08-10T05:01:00.000Z')
      ]
    });
    assert.deepEqual(
      state.received.map((p) => p.clientUuid),
      ['ok-a', 'ok-b', 'ok-c']
    );
  });

  it('flags historical beats so per-point rate limiting is skipped', async () => {
    await geoLiveService.recordHeartbeatsBatch({
      ...BASE,
      heartbeats: [
        beat('ok-old', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()),
        beat('ok-now', new Date().toISOString())
      ]
    });
    const old = state.received.find((p) => p.clientUuid === 'ok-old');
    const now = state.received.find((p) => p.clientUuid === 'ok-now');
    assert.equal(old.skipRateLimit, true);
    assert.equal(now.skipRateLimit, false);
  });

  it('moves the live pin only for live-usable accepted beats', async () => {
    await geoLiveService.recordHeartbeatsBatch({
      ...BASE,
      heartbeats: [
        beat('ok-1', '2026-08-10T05:00:00.000Z'),
        beat('history-1', '2026-08-10T05:01:00.000Z'),
        beat('badgps-1', '2026-08-10T05:02:00.000Z')
      ]
    });
    // history-only and invalid points must not update the snapshot.
    assert.equal(state.snapshotUpserts.length, 1);
  });

  it('rethrows infrastructure errors so the client retries the batch', async () => {
    await assert.rejects(
      geoLiveService.recordHeartbeatsBatch({
        ...BASE,
        heartbeats: [
          beat('ok-1', '2026-08-10T05:00:00.000Z'),
          beat('boom-1', '2026-08-10T05:01:00.000Z')
        ]
      }),
      (err) => err instanceof ApiError && err.statusCode === 500
    );
  });

  it('rejects the whole batch when live tracking is disabled for the company', async () => {
    await assert.rejects(
      geoLiveService.recordHeartbeatsBatch({
        ...BASE,
        company: { _id: COMPANY._id, liveTrackingEnabled: false },
        heartbeats: [beat('ok-1', '2026-08-10T05:00:00.000Z')]
      }),
      (err) => err.code === 'GEO_FEATURE_DISABLED'
    );
  });
});
