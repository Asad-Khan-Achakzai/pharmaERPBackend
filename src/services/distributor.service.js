const Distributor = require('../models/Distributor');
const DistributorInventory = require('../models/DistributorInventory');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const auditService = require('./audit.service');

const list = async (companyId, query, timeZone = "UTC") => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { city: { $regex: rx, $options: 'i' } }
    ];
  }
  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  applyCreatedByFromQuery(filter, query);
  const [docs, total] = await Promise.all([
    Distributor.find(filter).sort(sort).skip(skip).limit(limit),
    Distributor.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const distributor = await Distributor.create({ ...data, companyId, createdBy: reqUser.userId });
  await auditService.log({ companyId, userId: reqUser.userId, action: 'distributor.create', entityType: 'Distributor', entityId: distributor._id, changes: { after: distributor.toObject() } });
  return distributor;
};

const getById = async (companyId, id) => {
  const distributor = await Distributor.findOne({ _id: id, companyId });
  if (!distributor) throw new ApiError(404, 'Distributor not found');

  const inventory = await DistributorInventory.find({ companyId, distributorId: id })
    .populate('productId', 'name composition');

  return { ...distributor.toObject(), inventory };
};

const update = async (companyId, id, data, reqUser) => {
  const distributor = await Distributor.findOne({ _id: id, companyId });
  if (!distributor) throw new ApiError(404, 'Distributor not found');
  const before = distributor.toObject();
  Object.assign(distributor, { ...data, updatedBy: reqUser.userId });
  await distributor.save();
  await auditService.log({ companyId, userId: reqUser.userId, action: 'distributor.update', entityType: 'Distributor', entityId: distributor._id, changes: { before, after: distributor.toObject() } });
  return distributor;
};

const remove = async (companyId, id, reqUser) => {
  const distributor = await Distributor.findOne({ _id: id, companyId });
  if (!distributor) throw new ApiError(404, 'Distributor not found');
  await distributor.softDelete(reqUser.userId);
  await auditService.log({ companyId, userId: reqUser.userId, action: 'distributor.delete', entityType: 'Distributor', entityId: distributor._id, changes: { after: { isActive: false } } });
  return distributor;
};

module.exports = { list, create, getById, update, remove };
