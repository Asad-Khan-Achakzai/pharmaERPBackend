const notificationService = require('./notification.service');
const { NOTIFICATION_KIND, NOTIFICATION_CATEGORY } = require('../constants/enums');

/**
 * One notification per (field-day, rep, day) — never per visit.
 * Isolated from co-visit / partnerByDay accompaniment notifications.
 */
const notifyFieldDayAssigned = async ({
  companyId,
  fieldDayId,
  repUserId,
  managerName,
  dayYmd
}) => {
  if (!repUserId) return;
  await notificationService.createForUser({
    companyId,
    userId: repUserId,
    title: 'Field day with your manager',
    body: `${managerName || 'Your manager'} recorded a field day with you on ${dayYmd}.`,
    kind: NOTIFICATION_KIND.PLAN,
    link: '/visits',
    meta: {
      category: NOTIFICATION_CATEGORY.FIELD_OPS,
      managerFieldDayId: String(fieldDayId),
      dayYmd
    },
    dedupeKey: `mfd:${fieldDayId}:rep:${repUserId}:${dayYmd}`
  });
};

const notifyFieldDayRemoved = async ({
  companyId,
  fieldDayId,
  repUserId,
  managerName,
  dayYmd
}) => {
  if (!repUserId) return;
  await notificationService.createForUser({
    companyId,
    userId: repUserId,
    title: 'Field day cancelled',
    body: `${managerName || 'Your manager'} is no longer recording a field day with you on ${dayYmd}.`,
    kind: NOTIFICATION_KIND.PLAN,
    link: '/visits',
    meta: {
      category: NOTIFICATION_CATEGORY.FIELD_OPS,
      managerFieldDayId: String(fieldDayId),
      dayYmd
    },
    dedupeKey: `mfd:${fieldDayId}:rep-removed:${repUserId}:${dayYmd}`
  });
};

const notifyFieldDayDiff = async ({
  companyId,
  fieldDayId,
  addedIds,
  removedIds,
  managerName,
  dayYmd
}) => {
  await Promise.all([
    ...(addedIds || []).map((repUserId) =>
      notifyFieldDayAssigned({ companyId, fieldDayId, repUserId, managerName, dayYmd })
    ),
    ...(removedIds || []).map((repUserId) =>
      notifyFieldDayRemoved({ companyId, fieldDayId, repUserId, managerName, dayYmd })
    )
  ]);
};

module.exports = {
  notifyFieldDayAssigned,
  notifyFieldDayRemoved,
  notifyFieldDayDiff
};
