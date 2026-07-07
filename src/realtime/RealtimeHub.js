const { EventEmitter } = require('events');
const { RedisPubSubAdapter } = require('./RedisPubSubAdapter');

/** In-process event bus with optional Redis fan-out for multi-node deployments. */
class RealtimeHub extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(500);
    this.connectionCount = 0;
    this.redis = new RedisPubSubAdapter();
    this.redisReady = false;
  }

  async init() {
    this.redisReady = await this.redis.connect((companyId, channel, envelope) => {
      const key = this.channelKey(companyId, channel);
      const event = {
        channel,
        type: envelope.type,
        payload: envelope.payload,
        ts: new Date().toISOString(),
        companyId: String(companyId)
      };
      this.emit(key, event);
    });
  }

  channelKey(companyId, channel) {
    return `${companyId}:${channel}`;
  }

  publish(companyId, channel, envelope) {
    const key = this.channelKey(companyId, channel);
    const event = {
      channel,
      type: envelope.type,
      payload: envelope.payload,
      ts: new Date().toISOString(),
      companyId: String(companyId)
    };
    this.emit(key, event);
    if (this.redisReady) {
      void this.redis.publish(String(companyId), channel, envelope);
    }
    return event;
  }

  subscribe(companyId, channel, listener) {
    const key = this.channelKey(companyId, channel);
    this.on(key, listener);
    return () => this.off(key, listener);
  }

  incrementConnections() {
    this.connectionCount += 1;
  }

  decrementConnections() {
    this.connectionCount = Math.max(0, this.connectionCount - 1);
  }

  stats() {
    return { connections: this.connectionCount, redis: this.redisReady };
  }
}

const hub = new RealtimeHub();

module.exports = hub;
