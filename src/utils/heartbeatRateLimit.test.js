const ApiError = require('../utils/ApiError');

jest.mock('../config/env', () => ({ REDIS_URL: '' }));

const { assertHeartbeatRateLimit, initHeartbeatRateLimit } = require('./heartbeatRateLimit');

describe('heartbeatRateLimit', () => {
  beforeAll(async () => {
    await initHeartbeatRateLimit();
  });

  it('allows the first heartbeat for a user', async () => {
    await expect(assertHeartbeatRateLimit('co-1', 'user-1')).resolves.toBeUndefined();
  });

  it('rejects a second heartbeat inside the minimum gap', async () => {
    await expect(assertHeartbeatRateLimit('co-2', 'user-2')).resolves.toBeUndefined();
    await expect(assertHeartbeatRateLimit('co-2', 'user-2')).rejects.toMatchObject({
      statusCode: 429,
      message: 'Location updates too frequent',
    });
  });

  it('skips rate limit for historical capturedAt older than 2 minutes', async () => {
    const old = new Date(Date.now() - 5 * 60 * 1000);
    await expect(
      assertHeartbeatRateLimit('co-3', 'user-3', { capturedAt: old })
    ).resolves.toBeUndefined();
    await expect(
      assertHeartbeatRateLimit('co-3', 'user-3', { capturedAt: old })
    ).resolves.toBeUndefined();
  });
});
