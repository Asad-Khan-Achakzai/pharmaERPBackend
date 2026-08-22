const { WEEKLY_PLAN_STATUS } = require('../constants/enums');

const LIVE_STATUSES = new Set([
  WEEKLY_PLAN_STATUS.ACTIVE,
  WEEKLY_PLAN_STATUS.COMPLETED,
  WEEKLY_PLAN_STATUS.REVIEWED
]);

/**
 * Partner (DAY participants + Field Day listing + manager visit overlay)
 * is published only for a live plan.
 *
 * When approval is required, DRAFT / SUBMITTED stay private to the owner
 * until the plan is accepted (ACTIVE). When approval is not required, a
 * DRAFT is the working plan and is treated as live.
 */
const isPlanLiveForPartnership = (plan) => {
  if (!plan) return false;
  const status = plan.status;
  if (LIVE_STATUSES.has(status)) return true;
  if (status === WEEKLY_PLAN_STATUS.DRAFT && plan.approvalRequired !== true) return true;
  return false;
};

/** Plan items shown to a manager as Partner / Field Day visits. */
const isPlanItemLiveForPartnership = (item) => {
  const plan = item?.weeklyPlanId;
  if (plan && typeof plan === 'object' && plan.status) {
    return isPlanLiveForPartnership(plan);
  }
  return true;
};

const filterLivePartnershipItems = (items) =>
  (items || []).filter((item) => isPlanItemLiveForPartnership(item));

/**
 * Field Day selected list: hide reps whose covering weekly plan is not
 * accepted yet. Reps with no covering plan stay visible (Field Day-only).
 */
const hideFieldDayRepsPendingApproval = (repIds, pendingRepIdSet) => {
  const pending = pendingRepIdSet || new Set();
  return (repIds || []).filter((id) => {
    const key = String(id && typeof id === 'object' && id._id != null ? id._id : id);
    return !pending.has(key);
  });
};

const resolveLivePartnershipItems = async (items) => {
  const list = items || [];
  const ids = [];
  const seen = new Set();
  for (const item of list) {
    const plan = item?.weeklyPlanId;
    let id = '';
    if (plan && typeof plan === 'object' && plan._id != null) id = String(plan._id);
    else if (plan) id = String(plan);
    if (id && id !== '[object Object]' && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (!ids.length) return filterLivePartnershipItems(list);
  const WeeklyPlan = require('../models/WeeklyPlan');
  const plans = await WeeklyPlan.find({ _id: { $in: ids } })
    .select('status approvalRequired')
    .lean();
  const liveById = new Map(plans.map((p) => [String(p._id), isPlanLiveForPartnership(p)]));
  return list.filter((item) => {
    const plan = item?.weeklyPlanId;
    let id = '';
    if (plan && typeof plan === 'object' && plan._id != null) id = String(plan._id);
    else if (plan) id = String(plan);
    if (!id || id === '[object Object]' || !liveById.has(id)) {
      return isPlanItemLiveForPartnership(item);
    }
    return liveById.get(id);
  });
};

module.exports = {
  isPlanLiveForPartnership,
  isPlanItemLiveForPartnership,
  filterLivePartnershipItems,
  resolveLivePartnershipItems,
  hideFieldDayRepsPendingApproval
};
