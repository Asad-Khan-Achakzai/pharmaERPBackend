const Product = require('../models/Product');
const ProductTaxonomyNode = require('../models/ProductTaxonomyNode');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const auditService = require('./audit.service');
const { userHasPermission } = require('../utils/effectivePermissions');
const mediaAttach = require('./media.attach');
const productTaxonomyService = require('./productTaxonomy.service');

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

const PRODUCT_COST_PROJECTION_OMIT = '-casting -castingPercent -distributorPrice';

function canViewProductCostOnProductApi(reqUser) {
  if (!reqUser) return false;
  return userHasPermission(reqUser, 'products.viewCostPrice');
}

function omitCostFields(obj) {
  if (!obj) return obj;
  const { casting, castingPercent, distributorPrice, ...rest } = obj;
  return rest;
}

async function bumpCatalogVersion(product) {
  product.catalogVersion = (product.catalogVersion || 0) + 1;
}

async function applyTaxonomyLabels(companyId, productData) {
  if (productData.taxonomyNodeId === undefined) return productData;
  if (!productData.taxonomyNodeId) {
    productData.taxonomyPathLabels = [];
    return productData;
  }
  productData.taxonomyPathLabels = await productTaxonomyService.resolvePathLabels(
    companyId,
    productData.taxonomyNodeId
  );
  return productData;
}

function slugSkuFromName(name) {
  const base = String(name || 'product')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base || 'SKU'}-${suffix}`;
}

const list = async (companyId, query, reqUser, timeZone = 'UTC') => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (query.brandId) filter.brandId = query.brandId;
  if (query.taxonomyNodeId) filter.taxonomyNodeId = query.taxonomyNodeId;
  if (query.dosageForm) filter.dosageForm = query.dosageForm;
  if (query.isSampleEligible !== undefined) filter.isSampleEligible = query.isSampleEligible === 'true';
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { composition: { $regex: rx, $options: 'i' } },
      { genericName: { $regex: rx, $options: 'i' } },
      { sku: { $regex: rx, $options: 'i' } },
      { manufacturer: { $regex: rx, $options: 'i' } }
    ];
  }
  // Subtree filter: when taxonomyPathPrefix provided, match products under that path
  if (query.taxonomyPathPrefix) {
    const nodes = await ProductTaxonomyNode.find({
      companyId,
      materializedPath: { $regex: `^${escapeRegex(String(query.taxonomyPathPrefix))}` },
      isDeleted: { $ne: true }
    })
      .select('_id')
      .lean();
    filter.taxonomyNodeId = { $in: nodes.map((n) => n._id) };
  }
  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  applyCreatedByFromQuery(filter, query);
  let q = Product.find(filter)
    .populate('brandId', 'name code')
    .populate('taxonomyNodeId', 'name kind code')
    .sort(sort)
    .skip(skip)
    .limit(limit);
  if (!canViewProductCostOnProductApi(reqUser)) {
    q = q.select(PRODUCT_COST_PROJECTION_OMIT);
  }
  const [docs, total] = await Promise.all([q, Product.countDocuments(filter)]);
  const withUrls = await withImages(companyId, docs);
  return { docs: withUrls, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const { assetId, ...raw } = data;
  let productData = { ...raw };
  if (productData.brandId === '') productData.brandId = null;
  if (productData.taxonomyNodeId === '') productData.taxonomyNodeId = null;
  if (!productData.sku) productData.sku = slugSkuFromName(productData.name);
  if (!productData.genericName && productData.composition) {
    productData.genericName = productData.composition;
  }
  productData = await applyTaxonomyLabels(companyId, productData);
  productData.catalogVersion = 1;
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
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'product.create',
    entityType: 'Product',
    entityId: product._id,
    changes: { after: product.toObject() }
  });
  return withImages(companyId, product);
};

const getById = async (companyId, id, reqUser) => {
  let q = Product.findOne({ _id: id, companyId })
    .populate('brandId', 'name code')
    .populate('taxonomyNodeId', 'name kind code materializedPath');
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
  const { assetId, ...raw } = data;
  let productData = await applyTaxonomyLabels(companyId, { ...raw });
  Object.assign(product, { ...productData, updatedBy: reqUser.userId });
  await bumpCatalogVersion(product);
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
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'product.update',
    entityType: 'Product',
    entityId: product._id,
    changes: { before, after: product.toObject() }
  });
  return withImages(companyId, product);
};

const remove = async (companyId, id, reqUser) => {
  const product = await Product.findOne({ _id: id, companyId });
  if (!product) throw new ApiError(404, 'Product not found');
  await bumpCatalogVersion(product);
  product.isActive = false;
  await product.save();
  await product.softDelete(reqUser.userId);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'product.delete',
    entityType: 'Product',
    entityId: product._id,
    changes: { after: { isActive: false } }
  });
  return product;
};

/** Side-by-side compare — max 4 products. */
const compare = async (companyId, ids, reqUser) => {
  const list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : String(ids || '').split(',').filter(Boolean);
  if (list.length < 2) throw new ApiError(400, 'Provide at least 2 product ids');
  if (list.length > 4) throw new ApiError(400, 'Compare supports at most 4 products');
  let q = Product.find({ _id: { $in: list }, companyId, isActive: true })
    .populate('brandId', 'name code')
    .populate('taxonomyNodeId', 'name kind');
  if (!canViewProductCostOnProductApi(reqUser)) {
    q = q.select(PRODUCT_COST_PROJECTION_OMIT);
  }
  const docs = await q.lean();
  const withUrls = await withImages(companyId, docs);
  const byId = new Map(withUrls.map((d) => [String(d._id), d]));
  return list.map((id) => byId.get(id)).filter(Boolean);
};

/**
 * Delta catalog sync for mobile.
 * Returns products with catalogVersion > sinceVersion, plus soft-deleted ids since then.
 */
const sync = async (companyId, query, reqUser) => {
  const sinceVersion = Math.max(0, Number(query.sinceVersion) || 0);
  const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);
  const filter = { companyId, catalogVersion: { $gt: sinceVersion } };
  let q = Product.find(filter)
    .populate('brandId', 'name code')
    .sort({ catalogVersion: 1 })
    .limit(limit);
  if (!canViewProductCostOnProductApi(reqUser)) {
    q = q.select(PRODUCT_COST_PROJECTION_OMIT);
  }
  const docs = await q.lean();
  const deletedDocs = await Product.findDeleted({
    companyId,
    catalogVersion: { $gt: sinceVersion }
  })
    .select('_id catalogVersion')
    .limit(limit)
    .lean();
  const deletedIds = (deletedDocs || []).map((d) => String(d._id));

  const withUrls = await withImages(companyId, docs);
  const maxFromItems = withUrls.reduce((m, d) => Math.max(m, d.catalogVersion || 0), sinceVersion);
  const maxFromDeleted = (deletedDocs || []).reduce((m, d) => Math.max(m, d.catalogVersion || 0), sinceVersion);
  const maxVersion = Math.max(maxFromItems, maxFromDeleted);
  return {
    items: withUrls,
    deletedIds,
    maxVersion,
    hasMore: docs.length >= limit
  };
};

module.exports = {
  list,
  create,
  getById,
  update,
  remove,
  compare,
  sync,
  withImages,
  canViewProductCostOnProductApi,
  omitCostFields,
  bumpCatalogVersion
};
