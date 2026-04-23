const mongoose = require('mongoose');
const PlanItem = require('../models/PlanItem');
const WeeklyPlan = require('../models/WeeklyPlan');
const VisitLog = require('../models/VisitLog');
const Doctor = require('../models/Doctor');
const ApiError = require('../utils/ApiError');
const { PLAN_ITEM_TYPE, PLAN_ITEM_STATUS } = require('../constants/enums');
const { dateDocFromPstYmd, pstTodayYmd, pstYmdFromJsDate } = require('../utils/attendancePst');
const attendanceService = require('./attendance.service');
const auditService = require('./audit.service');

const normalizePlanItemDate = (input) => {
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return dateDocFromPstYmd(input);
  }
  const ymd = pstYmdFromJsDate(new Date(input));
  return dateDocFromPstYmd(ymd);
};

const assertDateWithinPlan = (itemDate, weekStart, weekEnd) => {
  const d = pstYmdFromJsDate(itemDate);
  const ws = pstYmdFromJsDate(new Date(weekStart));
  const we = pstYmdFromJsDate(new Date(weekEnd));
  if (d < ws || d > we) {
    throw new ApiError(400, 'Plan item date must fall within the weekly plan range');
  }
};

const listByPlan = async (companyId, weeklyPlanId) => {
  return PlanItem.find({ companyId, weeklyPlanId, isDeleted: { $ne: true } })
    .populate('doctorId', 'name specialization')
    .populate('visitLogId')
    .sort({ date: 1, createdAt: 1 })
    .lean();
};

/**
 * Pending items for a rep on a Pacific calendar day (default: today).
 */
const listTodayPending = async (companyId, employeeId, dateYmd) => {
  const ymd = dateYmd || pstTodayYmd();
  const dateDoc = dateDocFromPstYmd(ymd);
  return PlanItem.find({
    companyId,
    employeeId,
    date: dateDoc,
    status: PLAN_ITEM_STATUS.PENDING,
    isDeleted: { $ne: true }
  })
    .populate('doctorId', 'name specialization')
    .populate('weeklyPlanId', 'weekStartDate weekEndDate status')
    .sort({ createdAt: 1 })
    .lean();
};

const bulkCreateForPlan = async (companyId, weeklyPlanId, items, reqUser) => {
  if (!items?.length) throw new ApiError(400, 'At least one plan item is required');

  const plan = await WeeklyPlan.findOne({ _id: weeklyPlanId, companyId, isDeleted: { $ne: true } });
  if (!plan) throw new ApiError(404, 'Weekly plan not found');

  const employeeId = plan.medicalRepId;
  const docs = [];

  for (const raw of items) {
    const date = normalizePlanItemDate(raw.date);
    assertDateWithinPlan(date, plan.weekStartDate, plan.weekEndDate);

    const type = raw.type || PLAN_ITEM_TYPE.DOCTOR_VISIT;
    let doctorId = raw.doctorId || null;
    let title = (raw.title || '').trim();

    if (type === PLAN_ITEM_TYPE.DOCTOR_VISIT) {
      if (!doctorId) throw new ApiError(400, 'doctorId is required for doctor visits');
      const doctor = await Doctor.findOne({ _id: doctorId, companyId, isActive: true, isDeleted: { $ne: true } });
      if (!doctor) throw new ApiError(404, 'Doctor not found');
    } else {
      doctorId = null;
      if (!title) throw new ApiError(400, 'title is required for other tasks');
    }

    docs.push({
      companyId,
      weeklyPlanId,
      employeeId,
      date,
      type,
      doctorId,
      title: title || undefined,
      notes: raw.notes,
      status: PLAN_ITEM_STATUS.PENDING,
      createdBy: reqUser.userId
    });
  }

  try {
    const created = await PlanItem.insertMany(docs);
    await auditService.log({
      companyId,
      userId: reqUser.userId,
      action: 'planItem.bulkCreate',
      entityType: 'WeeklyPlan',
      entityId: weeklyPlanId,
      changes: { after: { count: created.length } }
    });
    return PlanItem.find({ _id: { $in: created.map((c) => c._id) } })
      .populate('doctorId', 'name specialization')
      .lean();
  } catch (e) {
    if (e && e.code === 11000) {
      throw new ApiError(400, 'Duplicate plan item: same doctor cannot be scheduled twice on the same day');
    }
    throw e;
  }
};

const markVisit = async (companyId, planItemId, body, reqUser) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const item = await PlanItem.findOne({
      _id: planItemId,
      companyId,
      isDeleted: { $ne: true }
    }).session(session);

    if (!item) throw new ApiError(404, 'Plan item not found');
    if (String(item.employeeId) !== String(reqUser.userId)) {
      throw new ApiError(403, 'You can only complete your own plan items');
    }
    if (item.status !== PLAN_ITEM_STATUS.PENDING) {
      throw new ApiError(400, 'Only pending plan items can be marked as visited');
    }

    await attendanceService.assertEmployeePresentForVisitDate(companyId, reqUser.userId, item.date);

    const visitTime = body.visitTime ? new Date(body.visitTime) : new Date();
    const doctorId =
      item.type === PLAN_ITEM_TYPE.DOCTOR_VISIT ? item.doctorId : body.doctorId || null;

    if (item.type === PLAN_ITEM_TYPE.DOCTOR_VISIT && !doctorId) {
      throw new ApiError(400, 'Plan item is missing doctor');
    }

    const [visitLog] = await VisitLog.create(
      [
        {
          companyId,
          planItemId: item._id,
          employeeId: reqUser.userId,
          doctorId,
          visitTime,
          checkInTime: body.checkInTime ? new Date(body.checkInTime) : undefined,
          checkOutTime: body.checkOutTime ? new Date(body.checkOutTime) : undefined,
          location: body.location?.lat != null && body.location?.lng != null
            ? { lat: body.location.lat, lng: body.location.lng }
            : undefined,
          notes: body.notes,
          orderTaken: Boolean(body.orderTaken),
          createdBy: reqUser.userId
        }
      ],
      { session }
    );

    item.status = PLAN_ITEM_STATUS.VISITED;
    item.visitLogId = visitLog._id;
    item.updatedBy = reqUser.userId;
    await item.save({ session });

    await session.commitTransaction();

    await auditService.log({
      companyId,
      userId: reqUser.userId,
      action: 'planItem.markVisit',
      entityType: 'PlanItem',
      entityId: item._id,
      changes: { after: item.toObject() }
    });

    return PlanItem.findById(item._id)
      .populate('doctorId', 'name specialization')
      .populate('visitLogId')
      .lean();
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
};

/**
 * Admin / planner: adjust status or notes without going through mark-visit flow.
 * Clearing non-VISITED status removes `visitLogId` (visit log rows are kept for audit).
 */
const updateByAdmin = async (companyId, planItemId, data, reqUser) => {
  const item = await PlanItem.findOne({ _id: planItemId, companyId, isDeleted: { $ne: true } });
  if (!item) throw new ApiError(404, 'Plan item not found');

  const before = item.toObject();
  if (data.status !== undefined) {
    if (!Object.values(PLAN_ITEM_STATUS).includes(data.status)) {
      throw new ApiError(400, 'Invalid status');
    }
    item.status = data.status;
    if (data.status !== PLAN_ITEM_STATUS.VISITED) {
      item.visitLogId = null;
    }
  }
  if (data.notes !== undefined) item.notes = data.notes;
  item.updatedBy = reqUser.userId;
  await item.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'planItem.updateAdmin',
    entityType: 'PlanItem',
    entityId: item._id,
    changes: { before, after: item.toObject() }
  });

  return PlanItem.findById(item._id)
    .populate('doctorId', 'name specialization')
    .populate('visitLogId')
    .lean();
};

const markMissedForPstDate = async (ymd) => {
  const dateDoc = dateDocFromPstYmd(ymd);
  const res = await PlanItem.updateMany(
    {
      date: dateDoc,
      status: PLAN_ITEM_STATUS.PENDING,
      isDeleted: { $ne: true }
    },
    { $set: { status: PLAN_ITEM_STATUS.MISSED } }
  );
  return res.modifiedCount || 0;
};

module.exports = {
  listByPlan,
  listTodayPending,
  bulkCreateForPlan,
  markVisit,
  updateByAdmin,
  markMissedForPstDate,
  normalizePlanItemDate
};
