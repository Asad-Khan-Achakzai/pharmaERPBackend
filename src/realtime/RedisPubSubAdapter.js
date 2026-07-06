/**
 * Placeholder for horizontal scaling — wire Redis pub/sub when running multiple nodes.
 * Single-node deployments use in-process RealtimeHub only.
 */
class RedisPubSubAdapter {
  constructor(_redisUrl) {
    this.enabled = false;
  }

  async connect() {
    return false;
  }

  async publish(_companyId, _channel, _envelope) {
    return false;
  }

  async subscribe(_companyId, _channel, _listener) {
    return () => {};
  }
}

module.exports = { RedisPubSubAdapter };
