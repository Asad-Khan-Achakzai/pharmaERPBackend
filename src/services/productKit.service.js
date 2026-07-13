const ProductKit = require('../models/ProductKit');
const Product = require('../models/Product');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const auditService = require('./audit.service');

const assertProducts = async (companyId, productIds) => {
  if (!Array.isArray(productIds) || productIds.length < 2) {
    throw new ApiError(400, 'A kit must contain at least 2 products');
  }
  const ids = [...new Set(productIds.map(String))];
  if (ids.length < 2) throw new ApiError(400, 'A kit must contain at least 2 distinct products');
  const count = await Product.countDocuments({ _id: { $in: ids }, companyId, isActive: true });
  if (count !== ids.length) throw new ApiError(400, 'One or more products are invalid or inactive');
  return ids;
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
    ProductKit.find(filter)
      .populate('productIds', 'name sku isActive')
      .sort(sort || { sortOrder: 1, name: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ProductKit.countDocuments(filter)
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
  const limit = Math.min(Number(query.limit) || 100, 100);
  return ProductKit.find(filter)
    .select('name code productIds sortOrder')
    .sort({ sortOrder: 1, name: 1 })
    .limit(limit)
    .lean();
};

const getById = async (companyId, id) => {
  const doc = await ProductKit.findOne({ _id: id, companyId })
    .populate('productIds', 'name sku packSize strength dosageForm isActive defaultPresentationId')
    .lean();
  if (!doc) throw new ApiError(404, 'Kit not found');
  return doc;
};

const create = async (companyId, data, reqUser) => {
  const productIds = await assertProducts(companyId, data.productIds || []);
  const doc = await ProductKit.create({
    companyId,
    name: String(data.name).trim(),
    code: data.code != null && String(data.code).trim() !== '' ? String(data.code).trim() : null,
    description: data.description || '',
    productIds,
    heroAssetId: data.heroAssetId || null,
    isActive: data.isActive !== false,
    sortOrder: data.sortOrder != null ? Number(data.sortOrder) : 0,
    createdBy: reqUser.userId
  });
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'kit.create',
    entityType: 'ProductKit',
    entityId: doc._id,
    changes: { after: doc.toObject() }
  });
  return doc.toObject();
};

const update = async (companyId, id, data, reqUser) => {
  const doc = await ProductKit.findOne({ _id: id, companyId });
  if (!doc) throw new ApiError(404, 'Kit not found');
  const before = doc.toObject();
  if (data.name != null) doc.name = String(data.name).trim();
  if (data.code !== undefined) {
    doc.code = data.code != null && String(data.code).trim() !== '' ? String(data.code).trim() : null;
  }
  if (data.description !== undefined) doc.description = data.description;
  if (data.productIds != null) doc.productIds = await assertProducts(companyId, data.productIds);
  if (data.heroAssetId !== undefined) doc.heroAssetId = data.heroAssetId || null;
  if (data.isActive !== undefined) doc.isActive = data.isActive;
  if (data.sortOrder !== undefined) doc.sortOrder = Number(data.sortOrder);
  doc.updatedBy = reqUser.userId;
  await doc.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'kit.update',
    entityType: 'ProductKit',
    entityId: doc._id,
    changes: { before, after: doc.toObject() }
  });
  return doc.toObject();
};

const remove = async (companyId, id, reqUser) => {
  const doc = await ProductKit.findOne({ _id: id, companyId });
  if (!doc) throw new ApiError(404, 'Kit not found');
  await doc.softDelete(reqUser.userId);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'kit.delete',
    entityType: 'ProductKit',
    entityId: doc._id,
    changes: { after: { isDeleted: true } }
  });
  return doc;
};

module.exports = { list, lookup, getById, create, update, remove };
