const MedRepTarget = require('../models/MedRepTarget');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const auditService = require('./audit.service');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');

const list = async (companyId, query, timeZone = "UTC") => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.medicalRepId) filter.medicalRepId = query.medicalRepId;
  if (query.month) filter.month = query.month;
  if (searchTerm && !query.month) {
    const rx = escapeRegex(searchTerm);
    filter.month = { $regex: rx, $options: 'i' };
  }
  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  applyCreatedByFromQuery(filter, query);
  const [docs, total] = await Promise.all([
    MedRepTarget.find(filter).populate('medicalRepId', 'name').sort(sort).skip(skip).limit(limit),
    MedRepTarget.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const target = await MedRepTarget.create({ ...data, companyId, createdBy: reqUser.userId });
  await auditService.log({ companyId, userId: reqUser.userId, action: 'target.create', entityType: 'MedRepTarget', entityId: target._id, changes: { after: target.toObject() } });
  return target;
};

const update = async (companyId, id, data, reqUser) => {
  const target = await MedRepTarget.findOne({ _id: id, companyId });
  if (!target) throw new ApiError(404, 'Target not found');
  const before = target.toObject();
  if (data.salesTarget !== undefined) target.salesTarget = data.salesTarget;
  if (data.packsTarget !== undefined) target.packsTarget = data.packsTarget;
  const sales = Number(target.salesTarget) || 0;
  const packs = Number(target.packsTarget) || 0;
  if (sales <= 0 && packs <= 0) {
    throw new ApiError(400, 'At least one of sales target or packs target must be greater than 0');
  }
  target.updatedBy = reqUser.userId;
  await target.save();
  await auditService.log({ companyId, userId: reqUser.userId, action: 'target.update', entityType: 'MedRepTarget', entityId: target._id, changes: { before, after: target.toObject() } });
  return target;
};

const remove = async (companyId, id, reqUser) => {
  const target = await MedRepTarget.findOne({ _id: id, companyId });
  if (!target) throw new ApiError(404, 'Target not found');
  const before = target.toObject();
  await target.softDelete(reqUser.userId);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'target.delete',
    entityType: 'MedRepTarget',
    entityId: target._id,
    changes: { before }
  });
};

const getByRep = async (companyId, repId) => {
  return MedRepTarget.find({ companyId, medicalRepId: repId }).sort({ month: -1 });
};

module.exports = { list, create, update, remove, getByRep };
