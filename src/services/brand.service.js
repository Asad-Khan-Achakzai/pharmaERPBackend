const Brand = require('../models/Brand');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const auditService = require('./audit.service');

const LOOKUP_MAX = 100;

const assertUniqueName = async (companyId, name, excludeId = null) => {
  const filter = {
    companyId,
    name: { $regex: `^${escapeRegex(String(name).trim())}$`, $options: 'i' },
    isDeleted: { $ne: true }
  };
  if (excludeId) filter._id = { $ne: excludeId };
  const existing = await Brand.findOne(filter).select('_id').lean();
  if (existing) throw new ApiError(409, 'Brand name already exists');
};

const list = async (companyId, query, timeZone = 'UTC') => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [{ name: { $regex: rx, $options: 'i' } }, { code: { $regex: rx, $options: 'i' } }];
  }
  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  applyCreatedByFromQuery(filter, query);
  const [docs, total] = await Promise.all([
    Brand.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Brand.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const lookup = async (companyId, query = {}) => {
  const searchTerm = qScalar(query.search);
  const filter = { companyId, isActive: true };
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [{ name: { $regex: rx, $options: 'i' } }, { code: { $regex: rx, $options: 'i' } }];
  }
  const limit = Math.min(Number(query.limit) || LOOKUP_MAX, LOOKUP_MAX);
  return Brand.find(filter).select('name code isActive').sort({ name: 1 }).limit(limit).lean();
};

const getById = async (companyId, id) => {
  const brand = await Brand.findOne({ _id: id, companyId }).lean();
  if (!brand) throw new ApiError(404, 'Brand not found');
  return brand;
};

const create = async (companyId, data, reqUser) => {
  await assertUniqueName(companyId, data.name);
  const brand = await Brand.create({
    companyId,
    name: String(data.name).trim(),
    code: data.code != null && String(data.code).trim() !== '' ? String(data.code).trim() : null,
    description: data.description || '',
    isActive: data.isActive !== false,
    createdBy: reqUser.userId
  });
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'brand.create',
    entityType: 'Brand',
    entityId: brand._id,
    changes: { after: brand.toObject() }
  });
  return brand.toObject();
};

const update = async (companyId, id, data, reqUser) => {
  const brand = await Brand.findOne({ _id: id, companyId });
  if (!brand) throw new ApiError(404, 'Brand not found');
  const before = brand.toObject();
  if (data.name != null) {
    await assertUniqueName(companyId, data.name, id);
    brand.name = String(data.name).trim();
  }
  if (data.code !== undefined) {
    brand.code = data.code != null && String(data.code).trim() !== '' ? String(data.code).trim() : null;
  }
  if (data.description !== undefined) brand.description = data.description;
  if (data.isActive !== undefined) brand.isActive = data.isActive;
  brand.updatedBy = reqUser.userId;
  await brand.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'brand.update',
    entityType: 'Brand',
    entityId: brand._id,
    changes: { before, after: brand.toObject() }
  });
  return brand.toObject();
};

const remove = async (companyId, id, reqUser) => {
  const brand = await Brand.findOne({ _id: id, companyId });
  if (!brand) throw new ApiError(404, 'Brand not found');
  await brand.softDelete(reqUser.userId);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'brand.delete',
    entityType: 'Brand',
    entityId: brand._id,
    changes: { after: { isActive: false } }
  });
  return brand;
};

module.exports = { list, lookup, getById, create, update, remove };
