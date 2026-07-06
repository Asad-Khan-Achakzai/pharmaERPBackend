const { EventEmitter } = require('events');

/** In-process event bus — swap RedisPubSubAdapter in multi-node deployments. */
class RealtimeHub extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(500);
    this.connectionCount = 0;
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
    return { connections: this.connectionCount };
  }
}

module.exports = new RealtimeHub();
