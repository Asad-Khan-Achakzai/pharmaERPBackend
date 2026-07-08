const mongoose = require('mongoose');
const ActiveVisit = require('../models/ActiveVisit');
const PlanItem = require('../models/PlanItem');
const Doctor = require('../models/Doctor');
const ApiError = require('../utils/ApiError');
const coVisit = require('./coVisit.service');

const listPopulate = [
  { path: 'doctorId', select: 'name specialization' },
  { path: 'planItemId', select: 'date plannedTime status type title doctorId' },
  { path: 'employeeId', select: 'name email' }
];

const toResponse = (row) => {
  if (!row) return null;
  const doctor = row.doctorId && typeof row.doctorId === 'object' ? row.doctorId : null;
  const employee = row.employeeId && typeof row.employeeId === 'object' ? row.employeeId : null;
  return {
    clientUuid: row.clientUuid,
    planItemId: row.planItemId ? String(row.planItemId._id || row.planItemId) : null,
    doctorId: String(row.doctorId?._id || row.doctorId),
    doctorName: doctor?.name ?? null,
    employeeId: String(row.employeeId?._id || row.employeeId),
    employeeName: employee?.name ?? null,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    visitStarted: row.visitStarted !== false,
    payload: row.payload || {}
  };
};

const resolveEmployeeFilter = (visibleEmployeeIds, employeeId) => {
  if (employeeId) {
    const eid = String(employeeId);
    if (Array.isArray(visibleEmployeeIds) && visibleEmployeeIds.length > 0) {
      const ok = visibleEmployeeIds.some((id) => String(id) === eid);
      if (!ok) throw new ApiError(403, 'You can only view active visits for yourself or your team');
    }
    return [new mongoose.Types.ObjectId(eid)];
  }
  if (visibleEmployeeIds === null) return null;
  if (!visibleEmployeeIds?.length) return [];
  return visibleEmployeeIds;
};

const listActive = async (companyId, visibleEmployeeIds, { employeeId } = {}) => {
  const employeeFilter = resolveEmployeeFilter(visibleEmployeeIds, employeeId);
  const query = {
    companyId,
    visitStarted: true,
    isDeleted: { $ne: true }
  };
  if (employeeFilter === null) {
    /* company-wide (admin) */
  } else if (employeeFilter.length === 0) {
    return [];
  } else {
    query.employeeId = { $in: employeeFilter };
  }

  const rows = await ActiveVisit.find(query).populate(listPopulate).sort({ updatedAt: -1 }).lean();

  const byKey = new Map();
  for (const row of rows) {
    const empId = String(row.employeeId?._id || row.employeeId);
    const key = row.planItemId
      ? `plan:${String(row.planItemId._id || row.planItemId)}:${empId}`
      : `doctor:${String(row.doctorId?._id || row.doctorId)}:${empId}`;
    const prev = byKey.get(key);
    if (!prev || new Date(row.updatedAt) > new Date(prev.updatedAt)) {
      byKey.set(key, row);
    }
  }

  return [...byKey.values()].map(toResponse);
};

const assertPlanItemAccess = async (companyId, employeeId, planItemId) => {
  const item = await PlanItem.findOne({
    _id: planItemId,
    companyId,
    isDeleted: { $ne: true }
  })
    .select('employeeId doctorId status participants')
    .lean();
  if (!item) throw new ApiError(404, 'Plan item not found');

  const isOwner = coVisit.isOwner(item, employeeId);
  const isParticipant = coVisit.canExecuteAsParticipant(item, employeeId);
  if (!isOwner && !isParticipant) {
    throw new ApiError(403, 'You are not authorized to start this visit');
  }
  if (isOwner && item.status !== 'PENDING') {
    throw new ApiError(400, 'This visit is no longer pending');
  }
  return item;
};

const upsertActive = async (companyId, employeeId, body) => {
  const clientUuid = String(body.clientUuid || '').trim();
  if (!clientUuid) throw new ApiError(400, 'clientUuid is required');

  const doctorId = body.doctorId;
  if (!doctorId || !mongoose.Types.ObjectId.isValid(doctorId)) {
    throw new ApiError(400, 'doctorId is required');
  }

  const doctor = await Doctor.findOne({ _id: doctorId, companyId, isDeleted: { $ne: true } }).select('_id').lean();
  if (!doctor) throw new ApiError(400, 'Invalid doctor');

  let planItemId = body.planItemId || null;
  if (planItemId) {
    if (!mongoose.Types.ObjectId.isValid(planItemId)) throw new ApiError(400, 'Invalid planItemId');
    await assertPlanItemAccess(companyId, employeeId, planItemId);
    planItemId = new mongoose.Types.ObjectId(String(planItemId));
  }

  const startedAt = body.startedAt ? new Date(body.startedAt) : new Date();
  if (Number.isNaN(startedAt.getTime())) throw new ApiError(400, 'Invalid startedAt');

  const visitStarted = body.visitStarted !== false;
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};

  const eid = new mongoose.Types.ObjectId(String(employeeId));
  const cid = new mongoose.Types.ObjectId(String(companyId));

  if (planItemId) {
    await ActiveVisit.deleteMany({
      companyId: cid,
      employeeId: eid,
      planItemId,
      clientUuid: { $ne: clientUuid }
    });
  } else {
    await ActiveVisit.deleteMany({
      companyId: cid,
      employeeId: eid,
      planItemId: null,
      doctorId: new mongoose.Types.ObjectId(String(doctorId)),
      clientUuid: { $ne: clientUuid }
    });
  }

  const doc = await ActiveVisit.findOneAndUpdate(
    { companyId: cid, employeeId: eid, clientUuid },
    {
      $set: {
        planItemId,
        doctorId: new mongoose.Types.ObjectId(String(doctorId)),
        startedAt,
        visitStarted,
        payload
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  )
    .populate(listPopulate)
    .lean();

  return toResponse(doc);
};

const clearActive = async (companyId, employeeId, clientUuid) => {
  await ActiveVisit.deleteMany({
    companyId,
    employeeId,
    clientUuid: String(clientUuid)
  });
};

const clearByPlanItemId = async (companyId, employeeId, planItemId) => {
  if (!planItemId) return;
  await ActiveVisit.deleteMany({
    companyId,
    employeeId,
    planItemId
  });
};

const loadByPlanItemId = async (companyId, employeeId, planItemId) => {
  const row = await ActiveVisit.findOne({
    companyId,
    employeeId,
    planItemId,
    visitStarted: true,
    isDeleted: { $ne: true }
  })
    .populate(listPopulate)
    .sort({ updatedAt: -1 })
    .lean();
  return toResponse(row);
};

const clearUnplannedByDoctorId = async (companyId, employeeId, doctorId) => {
  if (!doctorId) return;
  await ActiveVisit.deleteMany({
    companyId,
    employeeId,
    planItemId: null,
    doctorId: new mongoose.Types.ObjectId(String(doctorId))
  });
};

module.exports = {
  listActive,
  upsertActive,
  clearActive,
  clearByPlanItemId,
  loadByPlanItemId,
  clearUnplannedByDoctorId
};
