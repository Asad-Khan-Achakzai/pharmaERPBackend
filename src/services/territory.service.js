const mongoose = require('mongoose');
const Territory = require('../models/Territory');
const Doctor = require('../models/Doctor');
const Pharmacy = require('../models/Pharmacy');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar } = require('../utils/listQuery');
const { TERRITORY_KIND, TERRITORY_PARENT_KIND } = require('../constants/enums');
const auditService = require('./audit.service');

const oid = (v) => new mongoose.Types.ObjectId(v);

const buildPath = (parent, selfId) => {
  const base = parent ? parent.materializedPath || '/' : '/';
  return `${base}${String(selfId)}/`;
};

const depthForKind = (kind) =>
  kind === TERRITORY_KIND.ZONE ? 0 : kind === TERRITORY_KIND.AREA ? 1 : 2;

/**
 * Validate parent against {kind} rules and load parent doc when applicable.
 * Returns parent document (lean) or null when no parent expected.
 */
const resolveParent = async (companyId, kind, parentId) => {
  const expected = TERRITORY_PARENT_KIND[kind];
  if (expected == null) {
    if (parentId) throw new ApiError(400, 'Zone cannot have a parent');
    return null;
  }
  if (!parentId) {
    throw new ApiError(400, `${kind} requires a parent ${expected}`);
  }
  if (!mongoose.Types.ObjectId.isValid(parentId)) {
    throw new ApiError(400, 'parentId is not a valid id');
  }
  const parent = await Territory.findOne({
    _id: parentId,
    companyId,
    isDeleted: { $ne: true }
  }).lean();
  if (!parent) throw new ApiError(404, 'Parent territory not found');
  if (parent.kind !== expected) {
    throw new ApiError(400, `${kind} must be a child of ${expected}, got ${parent.kind}`);
  }
  return parent;
};

const list = async (companyId, query = {}) => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const filter = { companyId, isDeleted: { $ne: true } };
  if (query.kind && Object.values(TERRITORY_KIND).includes(query.kind)) {
    filter.kind = query.kind;
  }
  if (query.parentId === 'null' || query.parentId === '') {
    filter.parentId = null;
  } else if (query.parentId && mongoose.Types.ObjectId.isValid(query.parentId)) {
    filter.parentId = oid(query.parentId);
  }
  if (query.isActive === 'true' || query.isActive === 'false') {
    filter.isActive = query.isActive === 'true';
  }
  const term = qScalar(search);
  if (term) {
    const rx = escapeRegex(term);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { code: { $regex: rx, $options: 'i' } }
    ];
  }
  const [docs, total] = await Promise.all([
    Territory.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Territory.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

/** Returns the entire territory tree for a company in one call (used by the admin UI). */
const tree = async (companyId) => {
  const docs = await Territory.find({ companyId, isDeleted: { $ne: true } })
    .sort({ depth: 1, name: 1 })
    .lean();
  const byParent = new Map();
  for (const d of docs) {
    const key = d.parentId ? String(d.parentId) : 'ROOT';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(d);
  }
  const attach = (node) => ({
    ...node,
    children: (byParent.get(String(node._id)) || []).map(attach)
  });
  const roots = (byParent.get('ROOT') || []).map(attach);
  return { roots, total: docs.length };
};

const lookup = async (companyId, query = {}) => {
  const filter = { companyId, isDeleted: { $ne: true }, isActive: true };
  if (query.kind && Object.values(TERRITORY_KIND).includes(query.kind)) {
    filter.kind = query.kind;
  }
  if (query.parentId && mongoose.Types.ObjectId.isValid(query.parentId)) {
    filter.parentId = oid(query.parentId);
  }

  /**
   * `underUserId` — bricks in that user's reporting-subtree footprint
   * (primary + coverage territories expanded to bricks). Same ownership model as doctor list.
   */
  const underUserId = qScalar(query.underUserId);
  if (underUserId && mongoose.Types.ObjectId.isValid(underUserId)) {
    const { resolveSubtreeUserIds } = require('../utils/teamScope');
    const mrepOwnership = require('./mrepOwnership.service');
    const userIds = await resolveSubtreeUserIds(companyId, underUserId, {
      includeSelf: true,
      activeOnly: true
    });
    if (!userIds.length) return [];
    const users = await User.find({
      _id: { $in: userIds },
      companyId,
      isDeleted: { $ne: true },
      isActive: true
    })
      .select('territoryId coverageTerritoryIds')
      .lean();
    const brickSet = new Set();
    for (const u of users) {
      const bricks = await mrepOwnership.unionBrickIdsForRep(companyId, u);
      for (const b of bricks) brickSet.add(String(b));
    }
    if (!brickSet.size) return [];
    filter._id = { $in: [...brickSet].map((s) => oid(s)) };
    filter.kind = TERRITORY_KIND.BRICK;
  }

  const term = qScalar(query.search);
  if (term) {
    const rx = escapeRegex(term);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { code: { $regex: rx, $options: 'i' } }
    ];
  }
  const limit = Math.min(100, Number(query.limit) || 50);
  const rows = await Territory.find(filter)
    .select('name code kind parentId materializedPath')
    .sort({ name: 1 })
    .limit(limit)
    .lean();
  return rows;
};

const getById = async (companyId, id) => {
  const t = await Territory.findOne({ _id: id, companyId, isDeleted: { $ne: true } }).lean();
  if (!t) throw new ApiError(404, 'Territory not found');
  return t;
};

const create = async (companyId, data, reqUser) => {
  const parent = await resolveParent(companyId, data.kind, data.parentId);
  if (data.code) {
    const dup = await Territory.findOne({
      companyId,
      kind: data.kind,
      code: data.code,
      isDeleted: { $ne: true }
    }).lean();
    if (dup) throw new ApiError(409, `Code "${data.code}" already exists for ${data.kind}`);
  }
  const t = await Territory.create({
    companyId,
    name: data.name.trim(),
    code: data.code ? data.code.trim() : null,
    kind: data.kind,
    parentId: parent ? parent._id : null,
    materializedPath: '/',
    depth: depthForKind(data.kind),
    isActive: data.isActive !== false,
    notes: data.notes || null,
    createdBy: reqUser.userId
  });
  t.materializedPath = buildPath(parent, t._id);
  await t.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'territory.create',
    entityType: 'Territory',
    entityId: t._id,
    changes: { after: t.toObject() }
  });
  return t.toObject();
};

const update = async (companyId, id, data, reqUser) => {
  const t = await Territory.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
  if (!t) throw new ApiError(404, 'Territory not found');

  /**
   * Kind cannot change after creation (children would no longer satisfy the parent-kind invariant).
   * If you really need to "convert" a node, delete it and recreate.
   */
  if (data.kind && data.kind !== t.kind) {
    throw new ApiError(400, 'kind cannot be changed; recreate the territory instead');
  }

  const before = t.toObject();
  let parentChanged = false;

  if (data.parentId !== undefined) {
    const wantsParent = data.parentId && data.parentId !== '' ? data.parentId : null;
    const currentParent = t.parentId ? String(t.parentId) : null;
    if (String(wantsParent || '') !== String(currentParent || '')) {
      const parent = await resolveParent(companyId, t.kind, wantsParent);
      // Prevent cycles: new parent cannot be a descendant of t
      if (parent && (parent.materializedPath || '').includes(`/${String(t._id)}/`)) {
        throw new ApiError(400, 'Cannot move a territory under one of its own descendants');
      }
      t.parentId = parent ? parent._id : null;
      parentChanged = true;
    }
  }

  if (data.code !== undefined) {
    const next = data.code ? data.code.trim() : null;
    if (next && next !== t.code) {
      const dup = await Territory.findOne({
        companyId,
        kind: t.kind,
        code: next,
        _id: { $ne: t._id },
        isDeleted: { $ne: true }
      }).lean();
      if (dup) throw new ApiError(409, `Code "${next}" already exists for ${t.kind}`);
    }
    t.code = next;
  }
  if (data.name !== undefined) t.name = data.name.trim();
  if (data.isActive !== undefined) t.isActive = !!data.isActive;
  if (data.notes !== undefined) t.notes = data.notes || null;

  if (parentChanged) {
    const parent = t.parentId
      ? await Territory.findOne({ _id: t.parentId, companyId, isDeleted: { $ne: true } }).lean()
      : null;
    const newPath = buildPath(parent, t._id);
    const oldPath = before.materializedPath;
    t.materializedPath = newPath;
    t.depth = depthForKind(t.kind);
    t.updatedBy = reqUser.userId;
    await t.save();

    // Re-anchor descendants: replace the leading old path prefix with the new one.
    if (oldPath && oldPath !== newPath) {
      const descendants = await Territory.find({
        companyId,
        materializedPath: { $regex: `^${oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
        _id: { $ne: t._id },
        isDeleted: { $ne: true }
      });
      for (const d of descendants) {
        d.materializedPath = newPath + d.materializedPath.slice(oldPath.length);
        // depth unchanged (kind unchanged for both parents); keep as-is
        await d.save();
      }
    }
  } else {
    t.updatedBy = reqUser.userId;
    await t.save();
  }

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'territory.update',
    entityType: 'Territory',
    entityId: t._id,
    changes: { before, after: t.toObject() }
  });
  return t.toObject();
};

const remove = async (companyId, id, reqUser) => {
  const t = await Territory.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
  if (!t) throw new ApiError(404, 'Territory not found');

  // Block delete when descendants or assignments still reference it.
  const [childCount, doctorCount, pharmacyCount, userCount] = await Promise.all([
    Territory.countDocuments({
      companyId,
      parentId: t._id,
      isDeleted: { $ne: true }
    }),
    Doctor.countDocuments({ companyId, territoryId: t._id }),
    Pharmacy.countDocuments({ companyId, territoryId: t._id }),
    User.countDocuments({ companyId, territoryId: t._id, isDeleted: { $ne: true } })
  ]);

  const blockers = [];
  if (childCount) blockers.push(`${childCount} child territor${childCount === 1 ? 'y' : 'ies'}`);
  if (doctorCount) blockers.push(`${doctorCount} doctor${doctorCount === 1 ? '' : 's'}`);
  if (pharmacyCount) blockers.push(`${pharmacyCount} pharmac${pharmacyCount === 1 ? 'y' : 'ies'}`);
  if (userCount) blockers.push(`${userCount} user${userCount === 1 ? '' : 's'}`);
  if (blockers.length) {
    throw new ApiError(
      400,
      `Cannot delete: still referenced by ${blockers.join(', ')}. Reassign or delete them first.`
    );
  }

  await t.softDelete(reqUser.userId);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'territory.delete',
    entityType: 'Territory',
    entityId: t._id,
    changes: { after: { isDeleted: true } }
  });
  return { _id: t._id, isDeleted: true };
};

module.exports = { list, tree, lookup, getById, create, update, remove };
