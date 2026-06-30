const CallPoint = require('../models/CallPoint');
const WeeklyPlan = require('../models/WeeklyPlan');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const { CP_DAY_KEYS } = require('../constants/enums');
const auditService = require('./audit.service');

const cpByDayPaths = CP_DAY_KEYS.map((d) => `cpByDay.${d}`);

const assertUniqueName = async (companyId, name, excludeId) => {
  const filter = {
    companyId,
    name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' },
    isDeleted: { $ne: true }
  };
  if (excludeId) filter._id = { $ne: excludeId };
  const dup = await CallPoint.findOne(filter).lean();
  if (dup) throw new ApiError(409, `A CP named "${name}" already exists`);
};

const list = async (companyId, query = {}, timeZone = 'UTC') => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const filter = { companyId, isDeleted: { $ne: true } };
  if (query.isActive === 'true' || query.isActive === 'false') {
    filter.isActive = query.isActive === 'true';
  }
  const term = qScalar(search);
  if (term) {
    filter.name = { $regex: escapeRegex(term), $options: 'i' };
  }
  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  applyCreatedByFromQuery(filter, query);
  const [docs, total] = await Promise.all([
    CallPoint.find(filter).populate('createdBy', 'name').sort(sort).skip(skip).limit(limit).lean(),
    CallPoint.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

/** Active-only autocomplete used by the weekly plan day-CP dropdowns. */
const lookup = async (companyId, query = {}) => {
  const filter = { companyId, isDeleted: { $ne: true }, isActive: true };
  const term = qScalar(query.search);
  if (term) {
    filter.name = { $regex: escapeRegex(term), $options: 'i' };
  }
  const limit = Math.min(200, Number(query.limit) || 200);
  return CallPoint.find(filter)
    .select('name latitude longitude isActive')
    .sort({ name: 1 })
    .limit(limit)
    .lean();
};

const getById = async (companyId, id) => {
  const cp = await CallPoint.findOne({ _id: id, companyId, isDeleted: { $ne: true } }).lean();
  if (!cp) throw new ApiError(404, 'CP not found');
  return cp;
};

const create = async (companyId, data, reqUser) => {
  await assertUniqueName(companyId, data.name.trim());
  const cp = await CallPoint.create({
    companyId,
    name: data.name.trim(),
    latitude: Number(data.latitude),
    longitude: Number(data.longitude),
    isActive: data.isActive !== false,
    createdBy: reqUser.userId
  });
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'callPoint.create',
    entityType: 'CallPoint',
    entityId: cp._id,
    changes: { after: cp.toObject() }
  });
  return cp.toObject();
};

const update = async (companyId, id, data, reqUser) => {
  const cp = await CallPoint.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
  if (!cp) throw new ApiError(404, 'CP not found');
  const before = cp.toObject();
  if (data.name !== undefined) {
    const next = data.name.trim();
    if (next.toLowerCase() !== cp.name.toLowerCase()) {
      await assertUniqueName(companyId, next, cp._id);
    }
    cp.name = next;
  }
  if (data.latitude !== undefined) cp.latitude = Number(data.latitude);
  if (data.longitude !== undefined) cp.longitude = Number(data.longitude);
  if (data.isActive !== undefined) cp.isActive = !!data.isActive;
  cp.updatedBy = reqUser.userId;
  await cp.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'callPoint.update',
    entityType: 'CallPoint',
    entityId: cp._id,
    changes: { before, after: cp.toObject() }
  });
  return cp.toObject();
};

/** Count weekly plans that still reference a CP on any day. */
const countReferencingPlans = async (companyId, cpId) =>
  WeeklyPlan.countDocuments({
    companyId,
    isDeleted: { $ne: true },
    $or: cpByDayPaths.map((path) => ({ [path]: cpId }))
  });

const remove = async (companyId, id, reqUser) => {
  const cp = await CallPoint.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
  if (!cp) throw new ApiError(404, 'CP not found');

  const refCount = await countReferencingPlans(companyId, cp._id);
  if (refCount > 0) {
    throw new ApiError(
      400,
      `Cannot delete: this CP is used by ${refCount} weekly plan${refCount === 1 ? '' : 's'}. ` +
        'Remove it from those plans or deactivate it instead.'
    );
  }

  await cp.softDelete(reqUser.userId);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'callPoint.delete',
    entityType: 'CallPoint',
    entityId: cp._id,
    changes: { after: { isDeleted: true } }
  });
  return { _id: cp._id, isDeleted: true };
};

module.exports = { list, lookup, getById, create, update, remove, countReferencingPlans };
