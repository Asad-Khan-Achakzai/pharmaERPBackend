const Product = require('../models/Product');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const auditService = require('./audit.service');
const { userHasPermission } = require('../utils/effectivePermissions');

/** Cost-related fields; omitted from GET /products & GET /products/:id when user lacks products.viewCostPrice. */
const PRODUCT_COST_PROJECTION_OMIT = '-casting -castingPercent';

function canViewProductCostOnProductApi(reqUser) {
  if (!reqUser) return false;
  return userHasPermission(reqUser, 'products.viewCostPrice');
}

const list = async (companyId, query, reqUser) => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { composition: { $regex: rx, $options: 'i' } }
    ];
  }
  applyCreatedAtRangeFromQuery(filter, query);
  applyCreatedByFromQuery(filter, query);
  let q = Product.find(filter).sort(sort).skip(skip).limit(limit);
  if (!canViewProductCostOnProductApi(reqUser)) {
    q = q.select(PRODUCT_COST_PROJECTION_OMIT);
  }
  const [docs, total] = await Promise.all([q, Product.countDocuments(filter)]);
  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const product = await Product.create({ ...data, companyId, createdBy: reqUser.userId });
  await auditService.log({ companyId, userId: reqUser.userId, action: 'product.create', entityType: 'Product', entityId: product._id, changes: { after: product.toObject() } });
  return product;
};

const getById = async (companyId, id, reqUser) => {
  let q = Product.findOne({ _id: id, companyId });
  if (!canViewProductCostOnProductApi(reqUser)) {
    q = q.select(PRODUCT_COST_PROJECTION_OMIT);
  }
  const product = await q;
  if (!product) throw new ApiError(404, 'Product not found');
  return product;
};

const update = async (companyId, id, data, reqUser) => {
  const product = await Product.findOne({ _id: id, companyId });
  if (!product) throw new ApiError(404, 'Product not found');
  const before = product.toObject();
  Object.assign(product, { ...data, updatedBy: reqUser.userId });
  await product.save();
  await auditService.log({ companyId, userId: reqUser.userId, action: 'product.update', entityType: 'Product', entityId: product._id, changes: { before, after: product.toObject() } });
  return product;
};

const remove = async (companyId, id, reqUser) => {
  const product = await Product.findOne({ _id: id, companyId });
  if (!product) throw new ApiError(404, 'Product not found');
  await product.softDelete(reqUser.userId);
  await auditService.log({ companyId, userId: reqUser.userId, action: 'product.delete', entityType: 'Product', entityId: product._id, changes: { after: { isActive: false } } });
  return product;
};

module.exports = { list, create, getById, update, remove };
