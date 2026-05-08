const mongoose = require('mongoose');
const User = require('../models/User');
const Territory = require('../models/Territory');
const ApiError = require('./ApiError');
const { resolveSubtreeUserIds } = require('./teamScope');
const { escapeRegex } = require('./listQuery');
const {
  DEFAULT_MEDICAL_REP_CODE,
  DEFAULT_ADMIN_CODE
} = require('../constants/rbac');
const { ROLES } = require('../constants/enums');

const idsFromMaterializedPath = (path) => {
  const s = String(path || '').trim();
  if (!s || s === '/') return [];
  return s.split('/').filter(Boolean);
};

const normPrefix = (p) => {
  const x = String(p || '').trim();
  if (!x || x === '/') return null;
  return x.endsWith('/') ? x : `${x}/`;
};

async function expandSubtreePaths(companyId, pathInputs) {
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const normalized = [...new Set((pathInputs || []).map(normPrefix).filter(Boolean))];
  if (!normalized.length) return new Set();
  const or = normalized.map((prefix) => ({
    materializedPath: new RegExp(`^${escapeRegex(prefix)}`)
  }));
  const rows = await Territory.find({
    companyId: cid,
    isDeleted: { $ne: true },
    $or: or
  })
    .select('_id')
    .lean();
  return new Set(rows.map((r) => String(r._id)));
}

async function expandMedicalRepBrickSeed(companyId, doc) {
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const t = await Territory.findOne({
    _id: doc._id,
    companyId: cid,
    isDeleted: { $ne: true }
  })
    .select('_id materializedPath kind')
    .lean();
  if (!t) return new Set();
  const ids = new Set();
  ids.add(String(t._id));
  for (const id of idsFromMaterializedPath(t.materializedPath)) {
    ids.add(id);
  }
  const prefix = normPrefix(t.materializedPath);
  if (prefix) {
    const sub = await expandSubtreePaths(companyId, [prefix]);
    sub.forEach((id) => ids.add(id));
  }
  return ids;
}

/**
 * Territory ids a user may see for compare + tree-shaped UIs.
 * @returns {{ bypass: true, ids: null } | { bypass: false, ids: Set<string> }}
 */
async function buildAllowedTerritoryIdSet(companyId, viewerUserId, permissions) {
  const perms = Array.isArray(permissions) ? permissions : [];
  if (perms.includes('admin.access')) {
    return { bypass: true, ids: null };
  }

  const viewer = await User.findById(viewerUserId)
    .select('role roleId')
    .populate('roleId', 'code')
    .lean();
  if (viewer && viewer.role === ROLES.ADMIN) {
    return { bypass: true, ids: null };
  }
  if (viewer && viewer.roleId && viewer.roleId.code === DEFAULT_ADMIN_CODE) {
    return { bypass: true, ids: null };
  }

  let userIds = [viewerUserId];
  if (perms.includes('team.viewAllReports')) {
    userIds = await resolveSubtreeUserIds(companyId, viewerUserId, { includeSelf: true });
  }

  const users = await User.find({
    _id: { $in: userIds },
    companyId: new mongoose.Types.ObjectId(String(companyId)),
    isDeleted: { $ne: true }
  })
    .populate('roleId', 'code')
    .populate('territoryId', 'materializedPath kind')
    .populate('coverageTerritoryIds', 'materializedPath kind')
    .lean();

  const union = new Set();

  for (const u of users) {
    const code = u.roleId && u.roleId.code ? String(u.roleId.code) : '';
    const seeds = [];
    if (u.territoryId && u.territoryId._id) seeds.push(u.territoryId);
    if (Array.isArray(u.coverageTerritoryIds)) {
      for (const c of u.coverageTerritoryIds) {
        if (c && c._id) seeds.push(c);
      }
    }
    if (!seeds.length) continue;

    if (code === DEFAULT_MEDICAL_REP_CODE) {
      for (const s of seeds) {
        if (!s.materializedPath) continue;
        const kind = s.kind || '';
        if (kind === 'BRICK') {
          const part = await expandMedicalRepBrickSeed(companyId, s);
          part.forEach((id) => union.add(id));
        } else {
          const part = await expandSubtreePaths(companyId, [s.materializedPath]);
          part.forEach((id) => union.add(id));
        }
      }
    } else {
      const prefixes = seeds.map((s) => s.materializedPath).filter(Boolean);
      const part = await expandSubtreePaths(companyId, prefixes);
      part.forEach((id) => union.add(id));
    }
  }

  return { bypass: false, ids: union };
}

async function assertTerritoryCompareParentAccess(companyId, parentTerritoryId, scopeCtx) {
  if (scopeCtx.bypass) return;
  const pid = String(parentTerritoryId);
  if (!scopeCtx.ids || !scopeCtx.ids.size || !scopeCtx.ids.has(pid)) {
    throw new ApiError(403, 'You cannot view comparison data for this territory');
  }
}

module.exports = {
  buildAllowedTerritoryIdSet,
  assertTerritoryCompareParentAccess
};
