/**
 * Multi-channel delivery stubs (email / SMS / WhatsApp).
 * Push + in-app remain the primary channels via notification.service / push outbox.
 * These adapters are intentionally no-op until providers are configured.
 */
const logger = require('../utils/logger');
const env = require('../config/env');

async function sendEmail({ userId, title, body }) {
  if (env.NOTIFICATION_EMAIL_ENABLED !== '1') {
    logger.info('notification.channel.email_skipped', { userId: String(userId) });
    return { sent: false, skipped: true, channel: 'email' };
  }
  // Future: integrate SMTP / SES
  logger.warn('notification.channel.email_not_configured', { title });
  return { sent: false, skipped: true, channel: 'email', bodyPreview: String(body || '').slice(0, 80) };
}

async function sendSms({ userId, body }) {
  if (env.NOTIFICATION_SMS_ENABLED !== '1') {
    return { sent: false, skipped: true, channel: 'sms' };
  }
  logger.warn('notification.channel.sms_not_configured', { userId: String(userId) });
  return { sent: false, skipped: true, channel: 'sms', bodyPreview: String(body || '').slice(0, 80) };
}

async function sendWhatsApp({ userId, body }) {
  if (env.NOTIFICATION_WHATSAPP_ENABLED !== '1') {
    return { sent: false, skipped: true, channel: 'whatsapp' };
  }
  logger.warn('notification.channel.whatsapp_not_configured', { userId: String(userId) });
  return { sent: false, skipped: true, channel: 'whatsapp', bodyPreview: String(body || '').slice(0, 80) };
}

module.exports = { sendEmail, sendSms, sendWhatsApp };
