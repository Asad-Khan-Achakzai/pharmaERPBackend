const notificationService = require('./notification.service');
const { NOTIFICATION_KIND } = require('../constants/enums');
const businessTime = require('../utils/businessTime');

const fmtVisitWhen = (item, tz) => {
  const ymd = businessTime.businessDayKeyFromUtcInstant(item.date, tz);
  const time = item.plannedTime ? ` at ${item.plannedTime}` : '';
  return `${ymd}${time}`;
};

const doctorLabel = (item) => {
  const d = item.doctorId;
  if (d && typeof d === 'object' && d.name) return `Dr. ${d.name}`;
  return 'Doctor visit';
};

const notifyParticipantsAdded = async ({ companyId, planItem, addedUserIds, inviterUserId, timeZone }) => {
  if (!addedUserIds?.length) return;
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const when = fmtVisitWhen(planItem, tz);
  const doctor = doctorLabel(planItem);
  const link = `/visit/${planItem._id}`;

  await Promise.all(
    addedUserIds.map((userId) =>
      notificationService.createForUser({
        companyId,
        userId,
        title: 'Co-Visit invitation',
        body: `You have been invited to a Co-Visit: ${doctor}, ${when}`,
        kind: NOTIFICATION_KIND.PLAN,
        link,
        meta: { planItemId: String(planItem._id), inviterUserId: String(inviterUserId) }
      })
    )
  );
};

const notifyParticipantsRemoved = async ({ companyId, planItem, removedUserIds, timeZone }) => {
  if (!removedUserIds?.length) return;
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const when = fmtVisitWhen(planItem, tz);
  const doctor = doctorLabel(planItem);

  await Promise.all(
    removedUserIds.map((userId) =>
      notificationService.createForUser({
        companyId,
        userId,
        title: 'Removed from Co-Visit',
        body: `You have been removed from a Co-Visit: ${doctor}, ${when}`,
        kind: NOTIFICATION_KIND.PLAN,
        meta: { planItemId: String(planItem._id) }
      })
    )
  );
};

const notifyCoVisitUpdated = async ({ companyId, planItem, participantUserIds, timeZone }) => {
  if (!participantUserIds?.length) return;
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const when = fmtVisitWhen(planItem, tz);
  const doctor = doctorLabel(planItem);
  const link = `/visit/${planItem._id}`;

  await Promise.all(
    participantUserIds.map((userId) =>
      notificationService.createForUser({
        companyId,
        userId,
        title: 'Co-Visit updated',
        body: `Co-Visit schedule changed: ${doctor}, ${when}`,
        kind: NOTIFICATION_KIND.PLAN,
        link,
        meta: { planItemId: String(planItem._id) }
      })
    )
  );
};

module.exports = {
  notifyParticipantsAdded,
  notifyParticipantsRemoved,
  notifyCoVisitUpdated
};
