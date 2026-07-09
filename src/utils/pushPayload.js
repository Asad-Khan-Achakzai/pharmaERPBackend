const { NOTIFICATION_KIND } = require('../constants/enums');

/**
 * Lock-screen sanitization: sensitive kinds get generic title/body for Expo push.
 * Full detail remains on the in-app Notification document / feed.
 */
function sanitizePushContent({ kind, title, body }) {
  const k = kind || NOTIFICATION_KIND.GENERAL;
  if (k === NOTIFICATION_KIND.EXPENSE) {
    return {
      title: 'Expense update',
      body: 'Open PharmaERP to view details'
    };
  }
  if (k === NOTIFICATION_KIND.ATTENDANCE) {
    return {
      title: 'Attendance update',
      body: 'Open PharmaERP to view details'
    };
  }
  if (k === NOTIFICATION_KIND.PLAN) {
    return {
      title: 'Visit update',
      body: 'Open PharmaERP to view details'
    };
  }
  return {
    title: title || 'PharmaERP',
    body: body || ''
  };
}

/**
 * Build Expo `data` payload: routing ids only (no PII strings).
 */
function buildPushData({ notificationId, kind, link, meta }) {
  const data = {
    notificationId: String(notificationId),
    kind: kind || NOTIFICATION_KIND.GENERAL
  };
  if (link) data.link = String(link);
  if (meta && typeof meta === 'object') {
    for (const key of ['expenseId', 'requestId', 'planItemId', 'announcementId']) {
      if (meta[key] != null) data[key] = String(meta[key]);
    }
  }
  return data;
}

module.exports = { sanitizePushContent, buildPushData };
