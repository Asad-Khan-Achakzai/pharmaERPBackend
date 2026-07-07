const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');

const NODE_ID = crypto.randomUUID();

/**
 * Redis pub/sub for multi-node realtime when REDIS_URL is set.
 * Falls back gracefully when redis package or connection unavailable.
 */
class RedisPubSubAdapter {
  constructor(redisUrl) {
    this.redisUrl = redisUrl || env.REDIS_URL || '';
    this.pub = null;
    this.sub = null;
    this.enabled = false;
    this.onMessage = null;
  }

  topic(companyId, channel) {
    return `pharmaerp:rt:${companyId}:${channel}`;
  }

  async connect(onRemoteMessage) {
    this.onMessage = onRemoteMessage;
    if (!this.redisUrl) return false;

    try {
      const { createClient } = require('redis');
      this.pub = createClient({ url: this.redisUrl });
      this.sub = this.pub.duplicate();

      this.sub.on('error', (err) => logger.warn('Redis sub error:', err.message));
      this.pub.on('error', (err) => logger.warn('Redis pub error:', err.message));

      await this.pub.connect();
      await this.sub.connect();

      await this.sub.pSubscribe('pharmaerp:rt:*', (message, topic) => {
        try {
          const parsed = JSON.parse(message);
          if (parsed.originNodeId === NODE_ID) return;
          const parts = String(topic).split(':');
          const companyId = parts[2];
          const channel = parts.slice(3).join(':');
          if (companyId && channel && this.onMessage) {
            this.onMessage(companyId, channel, parsed.envelope || parsed);
          }
        } catch {
          /* ignore malformed */
        }
      });

      this.enabled = true;
      logger.info('Redis realtime pub/sub connected');
      return true;
    } catch (err) {
      logger.warn('Redis realtime unavailable — using in-process hub only:', err.message);
      this.enabled = false;
      return false;
    }
  }

  async publish(companyId, channel, envelope) {
    if (!this.enabled || !this.pub) return false;
    try {
      await this.pub.publish(
        this.topic(companyId, channel),
        JSON.stringify({ originNodeId: NODE_ID, envelope })
      );
      return true;
    } catch {
      return false;
    }
  }

  async disconnect() {
    try {
      await this.sub?.quit();
      await this.pub?.quit();
    } catch {
      /* ignore */
    }
    this.enabled = false;
  }
}

module.exports = { RedisPubSubAdapter, NODE_ID };
