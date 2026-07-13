const CatalogCampaign = require('../models/CatalogCampaign');
const Product = require('../models/Product');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const auditService = require('./audit.service');

const assertProducts = async (companyId, productIds) => {
  if (!Array.isArray(productIds) || productIds.length === 0) return [];
  const ids = [...new Set(productIds.map(String))];
  const count = await Product.countDocuments({ _id: { $in: ids }, companyId, isActive: true });
  if (count !== ids.length) throw new ApiError(400, 'One or more products are invalid or inactive');
  return ids;
};

const list = async (companyId, query, timeZone = 'UTC') => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (query.type) filter.type = query.type;
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [{ name: { $regex: rx, $options: 'i' } }, { code: { $regex: rx, $options: 'i' } }];
  }
  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  applyCreatedByFromQuery(filter, query);
  const [docs, total] = await Promise.all([
    CatalogCampaign.find(filter).sort(sort || { sortOrder: 1, name: 1 }).skip(skip).limit(limit).lean(),
    CatalogCampaign.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

/** Active campaigns in schedule window for catalog home. */
const listActive = async (companyId, now = new Date()) => {
  const filter = {
    companyId,
    isActive: true,
    $and: [
      { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
      { $or: [{ endAt: null }, { endAt: { $gte: now } }] }
    ]
  };
  return CatalogCampaign.find(filter)
    .sort({ sortOrder: 1, name: 1 })
    .populate('productIds', 'name sku isActive')
    .lean();
};

const getById = async (companyId, id) => {
  const doc = await CatalogCampaign.findOne({ _id: id, companyId })
    .populate('productIds', 'name sku isActive')
    .lean();
  if (!doc) throw new ApiError(404, 'Campaign not found');
  return doc;
};

const create = async (companyId, data, reqUser) => {
  const productIds = await assertProducts(companyId, data.productIds || []);
  const doc = await CatalogCampaign.create({
    companyId,
    name: String(data.name).trim(),
    code: data.code != null && String(data.code).trim() !== '' ? String(data.code).trim() : null,
    type: data.type || 'FEATURED',
    description: data.description || '',
    bannerAssetId: data.bannerAssetId || null,
    productIds,
    startAt: data.startAt || null,
    endAt: data.endAt || null,
    isActive: data.isActive !== false,
    sortOrder: data.sortOrder != null ? Number(data.sortOrder) : 0,
    createdBy: reqUser.userId
  });
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'campaign.create',
    entityType: 'CatalogCampaign',
    entityId: doc._id,
    changes: { after: doc.toObject() }
  });
  return doc.toObject();
};

const update = async (companyId, id, data, reqUser) => {
  const doc = await CatalogCampaign.findOne({ _id: id, companyId });
  if (!doc) throw new ApiError(404, 'Campaign not found');
  const before = doc.toObject();
  if (data.name != null) doc.name = String(data.name).trim();
  if (data.code !== undefined) {
    doc.code = data.code != null && String(data.code).trim() !== '' ? String(data.code).trim() : null;
  }
  if (data.type != null) doc.type = data.type;
  if (data.description !== undefined) doc.description = data.description;
  if (data.bannerAssetId !== undefined) doc.bannerAssetId = data.bannerAssetId || null;
  if (data.productIds != null) doc.productIds = await assertProducts(companyId, data.productIds);
  if (data.startAt !== undefined) doc.startAt = data.startAt || null;
  if (data.endAt !== undefined) doc.endAt = data.endAt || null;
  if (data.isActive !== undefined) doc.isActive = data.isActive;
  if (data.sortOrder !== undefined) doc.sortOrder = Number(data.sortOrder);
  doc.updatedBy = reqUser.userId;
  await doc.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'campaign.update',
    entityType: 'CatalogCampaign',
    entityId: doc._id,
    changes: { before, after: doc.toObject() }
  });
  return doc.toObject();
};

const remove = async (companyId, id, reqUser) => {
  const doc = await CatalogCampaign.findOne({ _id: id, companyId });
  if (!doc) throw new ApiError(404, 'Campaign not found');
  await doc.softDelete(reqUser.userId);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'campaign.delete',
    entityType: 'CatalogCampaign',
    entityId: doc._id,
    changes: { after: { isDeleted: true } }
  });
  return doc;
};

module.exports = { list, listActive, getById, create, update, remove };
