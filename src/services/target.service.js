const MedRepTarget = require('../models/MedRepTarget');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const auditService = require('./audit.service');

const list = async (companyId, query) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId };
  if (query.medicalRepId) filter.medicalRepId = query.medicalRepId;
  if (query.month) filter.month = query.month;
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
  target.updatedBy = reqUser.userId;
  await target.save();
  await auditService.log({ companyId, userId: reqUser.userId, action: 'target.update', entityType: 'MedRepTarget', entityId: target._id, changes: { before, after: target.toObject() } });
  return target;
};

const getByRep = async (companyId, repId) => {
  return MedRepTarget.find({ companyId, medicalRepId: repId }).sort({ month: -1 });
};

module.exports = { list, create, update, getByRep };
