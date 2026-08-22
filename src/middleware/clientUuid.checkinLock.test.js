/**
 * POST /attendance/checkin X-Client-Uuid lock: two in-flight requests with the
 * same UUID must not both call next() (i.e. must not both execute checkIn).
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function preloadStub(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports
  };
}

const store = new Map();

preloadStub('../models/IdempotencyRecord', {
  async create(doc) {
    if (store.has(doc.key)) {
      const err = new Error('E11000 duplicate');
      err.code = 11000;
      throw err;
    }
    const row = { ...doc, createdAt: new Date() };
    store.set(doc.key, row);
    return row;
  },
  findOne(query) {
    const row = store.get(query.key) || null;
    return {
      lean: async () => (row ? { ...row } : null)
    };
  },
  async updateOne(query, update) {
    const row = store.get(query.key);
    if (!row) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(row, update.$set || {});
    return { matchedCount: 1, modifiedCount: 1 };
  },
  async deleteOne(query) {
    const row = store.get(query.key);
    if (!row) return { deletedCount: 0 };
    if (query.statusCode != null && row.statusCode !== query.statusCode) {
      return { deletedCount: 0 };
    }
    store.delete(query.key);
    return { deletedCount: 1 };
  }
});

const { clientUuid, isAttendanceCheckInRequest, checkInLockConfig } = require('./clientUuid');

function mockReq({ method = 'POST', url = '/api/v1/attendance/checkin', uuid = 'u-1' } = {}) {
  return {
    method,
    originalUrl: url,
    path: url,
    user: { userId: 'user-1' },
    get: (name) => (String(name).toLowerCase() === 'x-client-uuid' ? uuid : undefined)
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    set(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  return res;
}

describe('isAttendanceCheckInRequest', () => {
  it('matches POST /attendance/checkin only', () => {
    assert.equal(
      isAttendanceCheckInRequest({ method: 'POST', originalUrl: '/api/v1/attendance/checkin' }),
      true
    );
    assert.equal(
      isAttendanceCheckInRequest({ method: 'POST', originalUrl: '/api/v1/attendance/checkout' }),
      false
    );
    assert.equal(
      isAttendanceCheckInRequest({ method: 'GET', originalUrl: '/api/v1/attendance/checkin' }),
      false
    );
  });
});

describe('check-in UUID lock', () => {
  beforeEach(() => {
    store.clear();
  });

  it('lets the first request through and replays a completed second request', async () => {
    const mw = clientUuid();
    const req1 = mockReq();
    const res1 = mockRes();
    let next1 = false;
    await mw(req1, res1, () => {
      next1 = true;
    });
    assert.equal(next1, true);
    res1.json({ success: true, data: { checkInTime: 't' } });
    await Promise.resolve();
    await Promise.resolve();

    const req2 = mockReq();
    const res2 = mockRes();
    let next2 = false;
    await mw(req2, res2, () => {
      next2 = true;
    });
    assert.equal(next2, false);
    assert.equal(res2.headers['X-Idempotent-Replay'], '1');
    assert.equal(res2.statusCode, 200);
  });

  it('does not execute checkIn while the first request is still in progress', async () => {
    const prevWait = checkInLockConfig.waitMs;
    const prevPoll = checkInLockConfig.pollMs;
    checkInLockConfig.waitMs = 400;
    checkInLockConfig.pollMs = 50;
    try {
      const mw = clientUuid();
      const req1 = mockReq({ uuid: 'in-flight' });
      const res1 = mockRes();
      await mw(req1, res1, () => {});

      const req2 = mockReq({ uuid: 'in-flight' });
      const res2 = mockRes();
      let next2 = false;
      await mw(req2, res2, () => {
        next2 = true;
      });
      assert.equal(next2, false);
      assert.equal(res2.statusCode, 503);
      assert.equal(res2.body && res2.body.code, 'ATTENDANCE_CHECKIN_IN_PROGRESS');
    } finally {
      checkInLockConfig.waitMs = prevWait;
      checkInLockConfig.pollMs = prevPoll;
    }
  });

  it('leaves checkout on the original findOne/create path (no in-progress lock)', async () => {
    const mw = clientUuid();
    const req = mockReq({ url: '/api/v1/attendance/checkout', uuid: 'co-1' });
    const res = mockRes();
    let next = false;
    await mw(req, res, () => {
      next = true;
    });
    assert.equal(next, true);
    assert.equal(store.size, 0);
    res.json({ ok: true });
    assert.equal(store.size, 1);
    assert.equal(store.get('user-1:co-1').statusCode, 200);
  });
});
