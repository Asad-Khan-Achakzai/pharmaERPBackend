const businessTime = require('./businessTime');
const { PLAN_ITEM_STATUS, PLAN_ITEM_TYPE, DAY_EXECUTION_STATE } = require('../constants/enums');

/**
 * @param {string} ymd
 * @param {string} planWeekStartYmd
 * @param {string} planWeekEndYmd
 */
const ymdInPlanWeek = (ymd, planWeekStartYmd, planWeekEndYmd) =>
  ymd >= planWeekStartYmd && ymd <= planWeekEndYmd;

/**
 * @param {import('mongoose').Types.ObjectId|string} companyId
 * @param {unknown} plan
 * @param {string} timeZone
 */
const planWeekYmdBounds = (plan, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ws = businessTime.businessDayKeyFromUtcInstant(plan.weekStartDate, tz);
  const we = businessTime.businessDayKeyFromUtcInstant(plan.weekEndDate, tz);
  return { weekStartYmd: ws, weekEndYmd: we };
};

/** Before first day of plan week in company TZ — structure fully editable. */
const isBeforePlanWeek = (plan, timeZone) => {
  const today = businessTime.nowInBusinessTime(businessTime.requireCompanyIanaZone(timeZone)).toISODate();
  const { weekStartYmd } = planWeekYmdBounds(plan, timeZone);
  return today < weekStartYmd;
};

/**
 * Past calendar days (strictly before business today) get note-only edits on items.
 * @param {string} itemYmd
 * @param {string} businessTodayYmd
 */
const isPastPlanDay = (itemYmd, businessTodayYmd) => itemYmd < businessTodayYmd;

/**
 * @param {string} itemYmd
 * @param {string} businessTodayYmd
 */
const canEditPlanItemStructure = (itemYmd, businessTodayYmd, plan, timeZone) => {
  if (isBeforePlanWeek(plan, timeZone)) return true;
  return !isPastPlanDay(itemYmd, businessTodayYmd);
};

/**
 * @param {{ status: string }[]} itemsOneDay
 */
const deriveDayExecutionState = (itemsOneDay) => {
  const list = (itemsOneDay || []).filter((x) => x && !x.isDeleted);
  if (list.length === 0) return DAY_EXECUTION_STATE.COMPLETED;
  const pending = list.filter((i) => i.status === PLAN_ITEM_STATUS.PENDING).length;
  if (pending === list.length) return DAY_EXECUTION_STATE.NOT_STARTED;
  const closed = list.filter(
    (i) => i.status === PLAN_ITEM_STATUS.VISITED || i.status === PLAN_ITEM_STATUS.MISSED
  ).length;
  if (closed === list.length) return DAY_EXECUTION_STATE.COMPLETED;
  return DAY_EXECUTION_STATE.IN_PROGRESS;
};

const summarizeExecutionCounts = (items) => {
  const list = items || [];
  const total = list.length;
  const visited = list.filter((i) => i.status === PLAN_ITEM_STATUS.VISITED).length;
  const missed = list.filter((i) => i.status === PLAN_ITEM_STATUS.MISSED).length;
  const pending = list.filter((i) => i.status === PLAN_ITEM_STATUS.PENDING).length;
  /** Progress = real coverage (visited/total). Missed is a deviation, NOT progress. */
  const progressPercent = total ? Math.round((visited / total) * 100) : 0;
  return { total, visited, missed, pending, progressPercent };
};

/**
 * Sequence vs actual visit time order for doctor visits (100 = all same order).
 * @param {{ type: string, status: string, sequenceOrder: number, actualVisitTime?: Date }[]} planItems
 */
const adherenceSequencePercent = (planItems) => {
  const doctorVisited = (planItems || []).filter(
    (i) =>
      i.type === PLAN_ITEM_TYPE.DOCTOR_VISIT &&
      i.status === PLAN_ITEM_STATUS.VISITED &&
      i.actualVisitTime != null
  );
  if (doctorVisited.length < 2) return 100;
  const bySeq = [...doctorVisited].sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
  const byTime = [...doctorVisited].sort(
    (a, b) => new Date(a.actualVisitTime).getTime() - new Date(b.actualVisitTime).getTime()
  );
  let matches = 0;
  for (let i = 0; i < bySeq.length; i += 1) {
    if (String(bySeq[i]._id) === String(byTime[i]._id)) matches += 1;
  }
  return Math.round((matches / bySeq.length) * 100);
};

/**
 * Week-level metrics for manager dashboards.
 */
const computePlanMetrics = (planItems, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const byDay = new Map();
  for (const it of planItems || []) {
    if (it.isDeleted) continue;
    const ymd = businessTime.businessDayKeyFromUtcInstant(it.date, tz);
    const arr = byDay.get(ymd) || [];
    arr.push(it);
    byDay.set(ymd, arr);
  }
  const daySummaries = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, dayItems]) => {
      const s = summarizeExecutionCounts(dayItems);
      return {
        date,
        state: deriveDayExecutionState(dayItems),
        ...s
      };
    });

  const sAll = summarizeExecutionCounts(planItems || []);
  const visitedCount = (planItems || []).filter((i) => i.status === PLAN_ITEM_STATUS.VISITED).length;
  const outOfOrderVisited = (planItems || []).filter((i) => i.status === PLAN_ITEM_STATUS.VISITED && i.wasOutOfOrder).length;
  const unplannedVisited = (planItems || []).filter((i) => i.status === PLAN_ITEM_STATUS.VISITED && i.isUnplanned).length;
  const coveragePercent = sAll.total > 0 ? Math.round((sAll.visited / sAll.total) * 100) : 0;
  const missedPercent = sAll.total > 0 ? Math.round((sAll.missed / sAll.total) * 100) : 0;
  const unplannedRatioPercent =
    visitedCount > 0 ? Math.round((unplannedVisited / visitedCount) * 100) : 0;

  return {
    coveragePercent,
    missedPercent,
    adherencePercent: adherenceSequencePercent(planItems || []),
    sequenceDeviationCount: outOfOrderVisited,
    unplannedCompletedCount: unplannedVisited,
    unplannedRatioPercent,
    daySummaries
  };
};

/**
 * Monday–Sunday ISO week containing `ymd` in `tz`.
 * @returns {{ mondayYmd: string, sundayYmd: string }}
 */
const mondaySundayRangeContainingYmd = (ymd, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const d = businessTime.businessDayStartUtc(ymd, tz);
  const dt = businessTime.toBusinessTime(d, tz);
  const monday = dt.minus({ days: dt.weekday - 1 }).startOf('day');
  const sunday = monday.plus({ days: 6 });
  return { mondayYmd: monday.toISODate(), sundayYmd: sunday.toISODate() };
};

module.exports = {
  ymdInPlanWeek,
  planWeekYmdBounds,
  isBeforePlanWeek,
  isPastPlanDay,
  canEditPlanItemStructure,
  deriveDayExecutionState,
  summarizeExecutionCounts,
  adherenceSequencePercent,
  computePlanMetrics,
  mondaySundayRangeContainingYmd
};
