/**
 * Central notification publisher — thin wrapper over createForUser with
 * eventName / category / priority metadata for the enterprise contract.
 * Domain services should prefer publishEvent() over ad-hoc createForUser calls.
 */
const notificationService = require('./notification.service');
const {
  NOTIFICATION_KIND,
  NOTIFICATION_CATEGORY,
  NOTIFICATION_PRIORITY
} = require('../constants/enums');
const logger = require('../utils/logger');

const EVENT_DEFAULTS = {
  'expense.submitted': {
    kind: NOTIFICATION_KIND.EXPENSE,
    category: NOTIFICATION_CATEGORY.APPROVALS,
    priority: NOTIFICATION_PRIORITY.URGENT,
    actionRequired: true
  },
  'expense.approved': {
    kind: NOTIFICATION_KIND.EXPENSE,
    category: NOTIFICATION_CATEGORY.OUTCOMES,
    priority: NOTIFICATION_PRIORITY.NORMAL,
    actionRequired: false
  },
  'expense.rejected': {
    kind: NOTIFICATION_KIND.EXPENSE,
    category: NOTIFICATION_CATEGORY.OUTCOMES,
    priority: NOTIFICATION_PRIORITY.HIGH,
    actionRequired: true
  },
  'attendance.request.pending': {
    kind: NOTIFICATION_KIND.ATTENDANCE,
    category: NOTIFICATION_CATEGORY.APPROVALS,
    priority: NOTIFICATION_PRIORITY.URGENT,
    actionRequired: true
  },
  'attendance.request.approved': {
    kind: NOTIFICATION_KIND.ATTENDANCE,
    category: NOTIFICATION_CATEGORY.OUTCOMES,
    priority: NOTIFICATION_PRIORITY.NORMAL,
    actionRequired: false
  },
  'attendance.request.rejected': {
    kind: NOTIFICATION_KIND.ATTENDANCE,
    category: NOTIFICATION_CATEGORY.OUTCOMES,
    priority: NOTIFICATION_PRIORITY.HIGH,
    actionRequired: true
  },
  'attendance.request.auto_rejected': {
    kind: NOTIFICATION_KIND.ATTENDANCE,
    category: NOTIFICATION_CATEGORY.OUTCOMES,
    priority: NOTIFICATION_PRIORITY.HIGH,
    actionRequired: true
  },
  'attendance.request.cancelled': {
    kind: NOTIFICATION_KIND.ATTENDANCE,
    category: NOTIFICATION_CATEGORY.OUTCOMES,
    priority: NOTIFICATION_PRIORITY.NORMAL,
    actionRequired: false
  },
  'plan.covisit.invited': {
    kind: NOTIFICATION_KIND.PLAN,
    category: NOTIFICATION_CATEGORY.FIELD_OPS,
    priority: NOTIFICATION_PRIORITY.HIGH,
    actionRequired: true
  },
  'plan.covisit.removed': {
    kind: NOTIFICATION_KIND.PLAN,
    category: NOTIFICATION_CATEGORY.FIELD_OPS,
    priority: NOTIFICATION_PRIORITY.NORMAL,
    actionRequired: false
  },
  'plan.covisit.updated': {
    kind: NOTIFICATION_KIND.PLAN,
    category: NOTIFICATION_CATEGORY.FIELD_OPS,
    priority: NOTIFICATION_PRIORITY.HIGH,
    actionRequired: false
  },
  'planItem.missed': {
    kind: NOTIFICATION_KIND.PLAN,
    category: NOTIFICATION_CATEGORY.FIELD_OPS,
    priority: NOTIFICATION_PRIORITY.HIGH,
    actionRequired: true
  },
  'announcement.published': {
    kind: NOTIFICATION_KIND.ANNOUNCEMENT,
    category: NOTIFICATION_CATEGORY.BROADCAST,
    priority: NOTIFICATION_PRIORITY.NORMAL,
    actionRequired: false
  },
  'weeklyPlan.submitted': {
    kind: NOTIFICATION_KIND.WEEKLY_PLAN,
    category: NOTIFICATION_CATEGORY.APPROVALS,
    priority: NOTIFICATION_PRIORITY.URGENT,
    actionRequired: true
  },
  'weeklyPlan.approved': {
    kind: NOTIFICATION_KIND.WEEKLY_PLAN,
    category: NOTIFICATION_CATEGORY.OUTCOMES,
    priority: NOTIFICATION_PRIORITY.NORMAL,
    actionRequired: false
  },
  'weeklyPlan.rejected': {
    kind: NOTIFICATION_KIND.WEEKLY_PLAN,
    category: NOTIFICATION_CATEGORY.OUTCOMES,
    priority: NOTIFICATION_PRIORITY.HIGH,
    actionRequired: true
  },
  'deviceChange.requested': {
    kind: NOTIFICATION_KIND.DEVICE,
    category: NOTIFICATION_CATEGORY.SECURITY,
    priority: NOTIFICATION_PRIORITY.URGENT,
    actionRequired: true
  },
  'deviceChange.approved': {
    kind: NOTIFICATION_KIND.DEVICE,
    category: NOTIFICATION_CATEGORY.SECURITY,
    priority: NOTIFICATION_PRIORITY.HIGH,
    actionRequired: true
  },
  'deviceChange.rejected': {
    kind: NOTIFICATION_KIND.DEVICE,
    category: NOTIFICATION_CATEGORY.SECURITY,
    priority: NOTIFICATION_PRIORITY.HIGH,
    actionRequired: true
  },
  'doctorLocation.pending': {
    kind: NOTIFICATION_KIND.DOCTOR_LOCATION,
    category: NOTIFICATION_CATEGORY.APPROVALS,
    priority: NOTIFICATION_PRIORITY.HIGH,
    actionRequired: true
  },
  'doctorLocation.resolved': {
    kind: NOTIFICATION_KIND.DOCTOR_LOCATION,
    category: NOTIFICATION_CATEGORY.OUTCOMES,
    priority: NOTIFICATION_PRIORITY.NORMAL,
    actionRequired: false
  },
  'order.delivered': {
    kind: NOTIFICATION_KIND.ORDER,
    category: NOTIFICATION_CATEGORY.COMMERCE,
    priority: NOTIFICATION_PRIORITY.NORMAL,
    actionRequired: false
  },
  'order.cancelled': {
    kind: NOTIFICATION_KIND.ORDER,
    category: NOTIFICATION_CATEGORY.COMMERCE,
    priority: NOTIFICATION_PRIORITY.HIGH,
    actionRequired: false
  }
};

/**
 * @param {object} opts
 * @param {string} opts.eventName
 * @param {string} opts.companyId
 * @param {string} opts.userId
 * @param {string} opts.title
 * @param {string} [opts.body]
 * @param {string} [opts.link]
 * @param {object} [opts.meta]
 * @param {string} [opts.dedupeKey]
 */
async function publishEvent({
  eventName,
  companyId,
  userId,
  title,
  body,
  link,
  meta,
  dedupeKey
}) {
  const defaults = EVENT_DEFAULTS[eventName] || {
    kind: NOTIFICATION_KIND.GENERAL,
    category: NOTIFICATION_CATEGORY.GENERAL,
    priority: NOTIFICATION_PRIORITY.NORMAL,
    actionRequired: false
  };

  const enrichedMeta = {
    ...(meta || {}),
    eventName,
    category: defaults.category,
    priority: defaults.priority,
    actionRequired: defaults.actionRequired
  };

  logger.info('notification.created', {
    eventName,
    kind: defaults.kind,
    companyId: String(companyId),
    userId: String(userId)
  });

  return notificationService.createForUser({
    companyId,
    userId,
    title,
    body: body || '',
    kind: defaults.kind,
    link,
    meta: enrichedMeta,
    dedupeKey
  });
}

async function publishEventSafe(opts) {
  try {
    return await publishEvent(opts);
  } catch (err) {
    logger.error('notification.publish_failed', {
      eventName: opts.eventName,
      err: err?.message
    });
    return null;
  }
}

module.exports = {
  publishEvent,
  publishEventSafe,
  EVENT_DEFAULTS,
  NOTIFICATION_KIND,
  NOTIFICATION_CATEGORY,
  NOTIFICATION_PRIORITY
};
