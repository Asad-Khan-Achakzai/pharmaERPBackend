const { NOTIFICATION_KIND, NOTIFICATION_PRIORITY } = require('../constants/enums');

const SANITIZED_KINDS = new Set([
  NOTIFICATION_KIND.EXPENSE,
  NOTIFICATION_KIND.ATTENDANCE,
  NOTIFICATION_KIND.PLAN,
  NOTIFICATION_KIND.WEEKLY_PLAN,
  NOTIFICATION_KIND.DEVICE,
  NOTIFICATION_KIND.DOCTOR_LOCATION
]);

const SANITIZE_COPY = {
  [NOTIFICATION_KIND.EXPENSE]: { title: 'Expense update', body: 'Open PharmaERP to view details' },
  [NOTIFICATION_KIND.ATTENDANCE]: { title: 'Attendance update', body: 'Open PharmaERP to view details' },
  [NOTIFICATION_KIND.PLAN]: { title: 'Visit update', body: 'Open PharmaERP to view details' },
  [NOTIFICATION_KIND.WEEKLY_PLAN]: { title: 'Weekly plan update', body: 'Open PharmaERP to view details' },
  [NOTIFICATION_KIND.DEVICE]: { title: 'Device update', body: 'Open PharmaERP to view details' },
  [NOTIFICATION_KIND.DOCTOR_LOCATION]: { title: 'Location review', body: 'Open PharmaERP to view details' }
};

/**
 * Lock-screen sanitization: sensitive kinds get generic title/body for Expo push.
 * Full detail remains on the in-app Notification document / feed.
 */
function sanitizePushContent({ kind, title, body }) {
  const k = kind || NOTIFICATION_KIND.GENERAL;
  if (SANITIZED_KINDS.has(k) && SANITIZE_COPY[k]) {
    return { ...SANITIZE_COPY[k] };
  }
  return {
    title: title || 'PharmaERP',
    body: body || ''
  };
}

const META_ID_KEYS = [
  'expenseId',
  'requestId',
  'planItemId',
  'announcementId',
  'weeklyPlanId',
  'deviceChangeRequestId',
  'suggestionId',
  'doctorId',
  'orderId'
];

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
    for (const key of META_ID_KEYS) {
      if (meta[key] != null) data[key] = String(meta[key]);
    }
    if (meta.category != null) data.category = String(meta.category);
    if (meta.priority != null) data.priority = String(meta.priority);
    if (meta.actionRequired != null) data.actionRequired = String(!!meta.actionRequired);
    if (meta.eventName != null) data.eventName = String(meta.eventName);
  }
  return data;
}

/** Map notification priority → Expo / Android channel id. */
function channelIdForMeta(meta) {
  const category = meta?.category;
  if (category === 'approvals' || category === 'security') return 'approvals';
  if (category === 'broadcast') return 'announcements';
  if (category === 'field_ops') return 'field';
  if (meta?.priority === NOTIFICATION_PRIORITY.URGENT) return 'approvals';
  return 'default';
}

module.exports = { sanitizePushContent, buildPushData, channelIdForMeta, META_ID_KEYS };
