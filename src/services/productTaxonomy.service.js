const mongoose = require('mongoose');
const ProductTaxonomyNode = require('../models/ProductTaxonomyNode');
const { PRODUCT_TAXONOMY_KIND, PRODUCT_TAXONOMY_PARENT_KIND } = require('../constants/enums');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar } = require('../utils/listQuery');
const auditService = require('./audit.service');

const oid = (v) => new mongoose.Types.ObjectId(v);

const depthForKind = (kind) => {
  if (kind === PRODUCT_TAXONOMY_KIND.THERAPY) return 0;
  if (kind === PRODUCT_TAXONOMY_KIND.AREA) return 1;
  return 2;
};

const buildPath = (parent, selfId) => {
  if (!parent) return `/${selfId}/`;
  const base = parent.materializedPath || '/';
  return `${base}${selfId}/`;
};

const resolveParent = async (companyId, kind, parentId) => {
  const expectedParentKind = PRODUCT_TAXONOMY_PARENT_KIND[kind];
  if (expectedParentKind == null) {
    if (parentId) throw new ApiError(400, 'Therapy nodes cannot have a parent');
    return null;
  }
  if (!parentId) throw new ApiError(400, `${kind} requires a parent`);
  const parent = await ProductTaxonomyNode.findOne({ _id: parentId, companyId, isDeleted: { $ne: true } });
  if (!parent) throw new ApiError(404, 'Parent taxonomy node not found');
  if (parent.kind !== expectedParentKind) {
    throw new ApiError(400, `${kind} parent must be ${expectedParentKind}`);
  }
  return parent;
};

const list = async (companyId, query = {}) => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId, isDeleted: { $ne: true } };
  if (query.kind) filter.kind = query.kind;
  if (query.parentId !== undefined) {
    filter.parentId = query.parentId === '' || query.parentId === 'null' ? null : query.parentId;
  }
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [{ name: { $regex: rx, $options: 'i' } }, { code: { $regex: rx, $options: 'i' } }];
  }
  const [docs, total] = await Promise.all([
    ProductTaxonomyNode.find(filter).sort(sort || { sortOrder: 1, name: 1 }).skip(skip).limit(limit).lean(),
    ProductTaxonomyNode.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const tree = async (companyId) => {
  const nodes = await ProductTaxonomyNode.find({ companyId, isDeleted: { $ne: true } })
    .sort({ sortOrder: 1, name: 1 })
    .lean();
  const byParent = new Map();
  for (const n of nodes) {
    const key = n.parentId ? String(n.parentId) : 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(n);
  }
  const attach = (parentKey) =>
    (byParent.get(parentKey) || []).map((n) => ({
      ...n,
      children: attach(String(n._id))
    }));
  return attach('root');
};

const lookup = async (companyId, query = {}) => {
  const searchTerm = qScalar(query.search);
  const filter = { companyId, isActive: true, isDeleted: { $ne: true } };
  if (query.kind) filter.kind = query.kind;
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [{ name: { $regex: rx, $options: 'i' } }, { code: { $regex: rx, $options: 'i' } }];
  }
  const limit = Math.min(Number(query.limit) || 100, 100);
  return ProductTaxonomyNode.find(filter)
    .select('name code kind parentId materializedPath depth sortOrder')
    .sort({ sortOrder: 1, name: 1 })
    .limit(limit)
    .lean();
};

const getById = async (companyId, id) => {
  const node = await ProductTaxonomyNode.findOne({ _id: id, companyId, isDeleted: { $ne: true } }).lean();
  if (!node) throw new ApiError(404, 'Taxonomy node not found');
  return node;
};

const create = async (companyId, data, reqUser) => {
  const kind = data.kind;
  if (!Object.values(PRODUCT_TAXONOMY_KIND).includes(kind)) {
    throw new ApiError(400, 'Invalid taxonomy kind');
  }
  const parent = await resolveParent(companyId, kind, data.parentId);
  const node = await ProductTaxonomyNode.create({
    companyId,
    name: String(data.name).trim(),
    code: data.code != null && String(data.code).trim() !== '' ? String(data.code).trim() : null,
    kind,
    parentId: parent ? parent._id : null,
    materializedPath: '/',
    depth: depthForKind(kind),
    sortOrder: data.sortOrder != null ? Number(data.sortOrder) : 0,
    isActive: data.isActive !== false,
    createdBy: reqUser.userId
  });
  node.materializedPath = buildPath(parent, node._id);
  await node.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'productTaxonomy.create',
    entityType: 'ProductTaxonomyNode',
    entityId: node._id,
    changes: { after: node.toObject() }
  });
  return node.toObject();
};

const update = async (companyId, id, data, reqUser) => {
  const node = await ProductTaxonomyNode.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
  if (!node) throw new ApiError(404, 'Taxonomy node not found');
  if (data.kind != null && data.kind !== node.kind) {
    throw new ApiError(400, 'Taxonomy kind cannot be changed');
  }
  const before = node.toObject();
  let pathChanged = false;
  if (data.parentId !== undefined) {
    const parent = await resolveParent(companyId, node.kind, data.parentId);
    if (parent && String(parent._id) === String(node._id)) {
      throw new ApiError(400, 'Node cannot be its own parent');
    }
    if (parent && parent.materializedPath && parent.materializedPath.includes(`/${node._id}/`)) {
      throw new ApiError(400, 'Cannot move node under its own descendant');
    }
    const oldPath = node.materializedPath;
    node.parentId = parent ? parent._id : null;
    node.materializedPath = buildPath(parent, node._id);
    pathChanged = oldPath !== node.materializedPath;
    if (pathChanged) {
      const descendants = await ProductTaxonomyNode.find({
        companyId,
        materializedPath: { $regex: `^${escapeRegex(oldPath)}` },
        _id: { $ne: node._id },
        isDeleted: { $ne: true }
      });
      for (const d of descendants) {
        d.materializedPath = String(d.materializedPath).replace(oldPath, node.materializedPath);
        await d.save();
      }
    }
  }
  if (data.name != null) node.name = String(data.name).trim();
  if (data.code !== undefined) {
    node.code = data.code != null && String(data.code).trim() !== '' ? String(data.code).trim() : null;
  }
  if (data.sortOrder !== undefined) node.sortOrder = Number(data.sortOrder);
  if (data.isActive !== undefined) node.isActive = data.isActive;
  node.updatedBy = reqUser.userId;
  await node.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'productTaxonomy.update',
    entityType: 'ProductTaxonomyNode',
    entityId: node._id,
    changes: { before, after: node.toObject() }
  });
  return node.toObject();
};

const remove = async (companyId, id, reqUser) => {
  const node = await ProductTaxonomyNode.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
  if (!node) throw new ApiError(404, 'Taxonomy node not found');
  const childCount = await ProductTaxonomyNode.countDocuments({
    companyId,
    parentId: node._id,
    isDeleted: { $ne: true }
  });
  if (childCount > 0) {
    throw new ApiError(409, 'Cannot delete a taxonomy node that has children — deactivate or move children first');
  }
  await node.softDelete(reqUser.userId);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'productTaxonomy.delete',
    entityType: 'ProductTaxonomyNode',
    entityId: node._id,
    changes: { after: { isActive: false } }
  });
  return node;
};

/** Resolve path labels [Therapy, Area, Class] for a node id. */
const resolvePathLabels = async (companyId, taxonomyNodeId) => {
  if (!taxonomyNodeId) return [];
  const node = await ProductTaxonomyNode.findOne({
    _id: taxonomyNodeId,
    companyId,
    isDeleted: { $ne: true }
  }).lean();
  if (!node || !node.materializedPath) return [];
  const ids = String(node.materializedPath)
    .split('/')
    .filter(Boolean);
  if (!ids.length) return [];
  const ancestors = await ProductTaxonomyNode.find({
    companyId,
    _id: { $in: ids.map(oid) },
    isDeleted: { $ne: true }
  })
    .select('name depth')
    .lean();
  ancestors.sort((a, b) => a.depth - b.depth);
  return ancestors.map((a) => a.name);
};

module.exports = {
  list,
  tree,
  lookup,
  getById,
  create,
  update,
  remove,
  resolvePathLabels
};
