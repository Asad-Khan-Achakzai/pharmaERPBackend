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
  const planItemId = String(planItem._id);

  await Promise.all(
    addedUserIds.map((userId) =>
      notificationService.createForUser({
        companyId,
        userId,
        title: 'Co-Visit invitation',
        body: `You have been invited to a Co-Visit: ${doctor}, ${when}`,
        kind: NOTIFICATION_KIND.PLAN,
        link,
        meta: { planItemId, inviterUserId: String(inviterUserId) },
        dedupeKey: `plan:${planItemId}:added:${userId}`
      })
    )
  );
};

const notifyParticipantsRemoved = async ({ companyId, planItem, removedUserIds, timeZone }) => {
  if (!removedUserIds?.length) return;
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const when = fmtVisitWhen(planItem, tz);
  const doctor = doctorLabel(planItem);
  const planItemId = String(planItem._id);
  const link = `/visit/${planItemId}`;

  await Promise.all(
    removedUserIds.map((userId) =>
      notificationService.createForUser({
        companyId,
        userId,
        title: 'Removed from Co-Visit',
        body: `You have been removed from a Co-Visit: ${doctor}, ${when}`,
        kind: NOTIFICATION_KIND.PLAN,
        link,
        meta: { planItemId },
        dedupeKey: `plan:${planItemId}:removed:${userId}`
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
  const planItemId = String(planItem._id);
  // Include schedule fingerprint so a later change can notify again.
  const stamp = `${when}|${doctor}`;

  await Promise.all(
    participantUserIds.map((userId) =>
      notificationService.createForUser({
        companyId,
        userId,
        title: 'Co-Visit updated',
        body: `Co-Visit schedule changed: ${doctor}, ${when}`,
        kind: NOTIFICATION_KIND.PLAN,
        link,
        meta: { planItemId },
        dedupeKey: `plan:${planItemId}:updated:${userId}:${stamp}`
      })
    )
  );
};

/**
 * Day-level accompaniment: ONE notification per (partner, day) — never one per
 * visit. dedupeKey makes re-application (plan edits, later bulk item creation
 * for the same day) idempotent.
 */
const notifyDayPartnerAssigned = async ({
  companyId,
  weeklyPlanId,
  partnerUserId,
  repName,
  dayYmd
}) => {
  if (!partnerUserId) return;
  await notificationService.createForUser({
    companyId,
    userId: partnerUserId,
    title: 'Accompaniment for the day',
    body: `You have been assigned as ${repName || 'a colleague'}'s accompanying partner for the visits on ${dayYmd}.`,
    kind: NOTIFICATION_KIND.PLAN,
    link: '/visits',
    meta: { weeklyPlanId: String(weeklyPlanId), dayYmd },
    dedupeKey: `wplan:${weeklyPlanId}:daypartner:${dayYmd}:${partnerUserId}`
  });
};

const notifyDayPartnerRemoved = async ({
  companyId,
  weeklyPlanId,
  partnerUserId,
  repName,
  dayYmd
}) => {
  if (!partnerUserId) return;
  await notificationService.createForUser({
    companyId,
    userId: partnerUserId,
    title: 'Accompaniment removed',
    body: `You are no longer ${repName || 'a colleague'}'s accompanying partner for ${dayYmd}.`,
    kind: NOTIFICATION_KIND.PLAN,
    link: '/visits',
    meta: { weeklyPlanId: String(weeklyPlanId), dayYmd },
    dedupeKey: `wplan:${weeklyPlanId}:daypartner-removed:${dayYmd}:${partnerUserId}`
  });
};

module.exports = {
  notifyParticipantsAdded,
  notifyParticipantsRemoved,
  notifyCoVisitUpdated,
  notifyDayPartnerAssigned,
  notifyDayPartnerRemoved
};
