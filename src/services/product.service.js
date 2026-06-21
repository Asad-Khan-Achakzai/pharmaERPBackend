const Product = require('../models/Product');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const auditService = require('./audit.service');
const { userHasPermission } = require('../utils/effectivePermissions');
const mediaAttach = require('./media.attach');

/** Attach a transient signed imageUrl to product docs from MediaAsset (source of truth). */
async function withImages(companyId, docs) {
  const list = Array.isArray(docs) ? docs : [docs];
  const ids = list.filter(Boolean).map((d) => String(d._id));
  const images = await mediaAttach.resolveEntityImages({ companyId, resource: 'products', ids });
  const decorate = (d) => {
    if (!d) return d;
    const obj = typeof d.toObject === 'function' ? d.toObject() : d;
    const img = images.get(String(obj._id));
    obj.imageUrl = img ? img.url : null;
    return obj;
  };
  return Array.isArray(docs) ? list.map(decorate) : decorate(docs);
}

/** Cost-related fields; omitted from GET /products & GET /products/:id when user lacks products.viewCostPrice. */
const PRODUCT_COST_PROJECTION_OMIT = '-casting -castingPercent';

function canViewProductCostOnProductApi(reqUser) {
  if (!reqUser) return false;
  return userHasPermission(reqUser, 'products.viewCostPrice');
}

const list = async (companyId, query, reqUser, timeZone = "UTC") => {
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
  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  applyCreatedByFromQuery(filter, query);
  let q = Product.find(filter).sort(sort).skip(skip).limit(limit);
  if (!canViewProductCostOnProductApi(reqUser)) {
    q = q.select(PRODUCT_COST_PROJECTION_OMIT);
  }
  const [docs, total] = await Promise.all([q, Product.countDocuments(filter)]);
  const withUrls = await withImages(companyId, docs);
  return { docs: withUrls, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const { assetId, ...productData } = data;
  const product = await Product.create({ ...productData, companyId, createdBy: reqUser.userId });
  if (assetId) {
    await mediaAttach.attachEntityImage({
      companyId,
      uploadedBy: reqUser.userId,
      resource: 'products',
      id: product._id,
      assetId
    });
  }
  await auditService.log({ companyId, userId: reqUser.userId, action: 'product.create', entityType: 'Product', entityId: product._id, changes: { after: product.toObject() } });
  return withImages(companyId, product);
};

const getById = async (companyId, id, reqUser) => {
  let q = Product.findOne({ _id: id, companyId });
  if (!canViewProductCostOnProductApi(reqUser)) {
    q = q.select(PRODUCT_COST_PROJECTION_OMIT);
  }
  const product = await q;
  if (!product) throw new ApiError(404, 'Product not found');
  return withImages(companyId, product);
};

const update = async (companyId, id, data, reqUser) => {
  const product = await Product.findOne({ _id: id, companyId });
  if (!product) throw new ApiError(404, 'Product not found');
  const before = product.toObject();
  const { assetId, ...productData } = data;
  Object.assign(product, { ...productData, updatedBy: reqUser.userId });
  await product.save();
  if (assetId) {
    await mediaAttach.attachEntityImage({
      companyId,
      uploadedBy: reqUser.userId,
      resource: 'products',
      id: product._id,
      assetId
    });
  }
  await auditService.log({ companyId, userId: reqUser.userId, action: 'product.update', entityType: 'Product', entityId: product._id, changes: { before, after: product.toObject() } });
  return withImages(companyId, product);
};

const remove = async (companyId, id, reqUser) => {
  const product = await Product.findOne({ _id: id, companyId });
  if (!product) throw new ApiError(404, 'Product not found');
  await product.softDelete(reqUser.userId);
  await auditService.log({ companyId, userId: reqUser.userId, action: 'product.delete', entityType: 'Product', entityId: product._id, changes: { after: { isActive: false } } });
  return product;
};

module.exports = { list, create, getById, update, remove };
