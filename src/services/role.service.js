const mongoose = require('mongoose');
const Role = require('../models/Role');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { ALL_PERMISSIONS } = require('../constants/permissions');
const {
  ADMIN_ACCESS,
  ROLES_MANAGE,
  DEFAULT_ADMIN_CODE,
  DEFAULT_MEDICAL_REP_CODE
} = require('../constants/rbac');
const { ROLES } = require('../constants/enums');
const auditService = require('./audit.service');
const {
  escapeRegex,
  qScalar,
  applyCreatedAtRangeFromQuery,
  applyCreatedByFromQuery
} = require('../utils/listQuery');

/**
 * Consistent ObjectId for multi-tenant queries (avoids empty results when user.companyId is
 * populated object, Buffer, or 24-char hex string vs stored ObjectId in Role).
 */
const toCompanyObjectId = (companyId) => {
  if (companyId == null) return null;
  if (companyId instanceof mongoose.Types.ObjectId) return companyId;
  if (typeof companyId === 'object' && companyId._id != null) {
    return toCompanyObjectId(companyId._id);
  }
  if (typeof companyId === 'string' && mongoose.isValidObjectId(companyId)) {
    return new mongoose.Types.ObjectId(companyId);
  }
  if (Buffer.isBuffer(companyId) && companyId.length === 12) {
    return new mongoose.Types.ObjectId(companyId);
  }
  if (typeof companyId === 'object' && companyId.toString) {
    const s = String(companyId);
    if (mongoose.isValidObjectId(s)) return new mongoose.Types.ObjectId(s);
  }
  return companyId;
};

const DEFAULT_MEDICAL_REP_PERMISSIONS = [
  'dashboard.view',
  'products.view',
  'distributors.view',
  'inventory.view',
  'pharmacies.view',
  'orders.view',
  'orders.create',
  'payments.view',
  'payments.create',
  'ledger.view',
  'reports.view',
  'attendance.view',
  'attendance.mark'
];

const isValidPermission = (p) => ALL_PERMISSIONS.includes(p);

const assertPermissions = (arr) => {
  if (!Array.isArray(arr)) throw new ApiError(400, 'permissions must be an array');
  const bad = arr.filter((p) => !isValidPermission(p));
  if (bad.length) throw new ApiError(400, `Invalid permissions: ${bad.join(', ')}`);
};

/**
 * Create default system roles for a new company. Idempotent when codes exist.
 * @returns {{ adminRole: import('mongoose').Document, medicalRole: import('mongoose').Document }}
 */
const seedDefaultRolesForCompany = async (companyId, { createdBy = null } = {}) => {
  const cid = toCompanyObjectId(companyId);
  if (!cid) throw new ApiError(400, 'companyId is required to seed roles');
  const base = { companyId: cid, isSystem: true, createdBy };

  let adminRole = await Role.findOne({ companyId: cid, code: DEFAULT_ADMIN_CODE });
  if (!adminRole) {
    adminRole = await Role.create({
      ...base,
      name: 'Administrator',
      code: DEFAULT_ADMIN_CODE,
      permissions: [ADMIN_ACCESS, ROLES_MANAGE]
    });
  }

  let medicalRole = await Role.findOne({ companyId: cid, code: DEFAULT_MEDICAL_REP_CODE });
  if (!medicalRole) {
    medicalRole = await Role.create({
      ...base,
      name: 'Medical Representative',
      code: DEFAULT_MEDICAL_REP_CODE,
      permissions: [...DEFAULT_MEDICAL_REP_PERMISSIONS]
    });
  }

  return { adminRole, medicalRole };
};

const list = async (companyId, query) => {
  const cid = toCompanyObjectId(companyId);
  if (!cid) throw new ApiError(400, 'Company context is required for roles list');

  await seedDefaultRolesForCompany(cid);

  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);

  await seedDefaultRolesForCompany(cid);

  const filter = { companyId: cid, isDeleted: { $ne: true } };
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { code: { $regex: rx, $options: 'i' } }
    ];
  }
  applyCreatedAtRangeFromQuery(filter, query);
  applyCreatedByFromQuery(filter, query);
  const [docs, total] = await Promise.all([
    Role.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Role.countDocuments(filter)
  ]);
  const ids = docs.map((d) => d._id);
  const counts = await User.aggregate([
    {
      $match: {
        companyId: cid,
        roleId: { $in: ids },
        isDeleted: { $ne: true }
      }
    },
    { $group: { _id: '$roleId', c: { $sum: 1 } } }
  ]);
  const countMap = Object.fromEntries(counts.map((x) => [String(x._id), x.c]));
  const withCount = docs.map((d) => ({ ...d, userCount: countMap[String(d._id)] || 0 }));
  return { docs: withCount, total, page, limit };
};

const getById = async (companyId, id) => {
  const cid = toCompanyObjectId(companyId);
  await seedDefaultRolesForCompany(cid);
  const role = await Role.findOne({ _id: id, companyId: cid, isDeleted: { $ne: true } });
  if (!role) throw new ApiError(404, 'Role not found');
  return role;
};

const create = async (companyId, data, reqUser) => {
  const cid = toCompanyObjectId(companyId);
  if (!cid) throw new ApiError(400, 'Company context is required');
  assertPermissions(data.permissions || []);
  if (!data.name?.trim()) throw new ApiError(400, 'name is required');
  if (data.code && (await Role.findOne({ companyId: cid, code: data.code, isDeleted: { $ne: true } }))) {
    throw new ApiError(409, 'Role code already exists in this company');
  }
  const role = await Role.create({
    companyId: cid,
    name: data.name.trim(),
    code: data.code?.trim() || null,
    permissions: data.permissions || [],
    isSystem: false,
    createdBy: reqUser.userId
  });
  await auditService.log({
    companyId: cid,
    userId: reqUser.userId,
    action: 'role.create',
    entityType: 'Role',
    entityId: role._id,
    changes: { after: role.toObject() }
  });
  return role;
};

const update = async (companyId, id, data, reqUser) => {
  const cid = toCompanyObjectId(companyId);
  const role = await Role.findOne({ _id: id, companyId: cid, isDeleted: { $ne: true } });
  if (!role) throw new ApiError(404, 'Role not found');
  if (data.permissions !== undefined) {
    if (role.isSystem) {
      const next = data.permissions;
      if (!Array.isArray(next) || next.length === 0) {
        throw new ApiError(400, 'System role must keep at least one permission');
      }
      if (role.code === DEFAULT_ADMIN_CODE && !next.includes(ADMIN_ACCESS)) {
        throw new ApiError(400, 'Administrator role must keep admin.access');
      }
    }
    assertPermissions(data.permissions);
  }
  const before = role.toObject();
  if (data.name !== undefined) role.name = data.name.trim();
  if (data.code !== undefined) {
    if (role.isSystem && role.code && data.code !== role.code) {
      throw new ApiError(400, 'System role code cannot be changed');
    }
    if (data.code) {
      const dup = await Role.findOne({ companyId: cid, code: data.code, _id: { $ne: id }, isDeleted: { $ne: true } });
      if (dup) throw new ApiError(409, 'Role code already exists in this company');
    }
    role.code = data.code?.trim() || null;
  }
  if (data.permissions !== undefined) role.permissions = data.permissions;
  role.updatedBy = reqUser.userId;
  await role.save();
  await auditService.log({
    companyId: cid,
    userId: reqUser.userId,
    action: 'role.update',
    entityType: 'Role',
    entityId: role._id,
    changes: { before, after: role.toObject() }
  });
  return role;
};

const remove = async (companyId, id, reqUser) => {
  const cid = toCompanyObjectId(companyId);
  if (!cid) throw new ApiError(400, 'Company context is required');

  // 1–2) Role must exist in this company (enforces company scope; cross-tenant id → 404)
  const role = await Role.findOne({ _id: id, companyId: cid, isDeleted: { $ne: true } });
  if (!role) throw new ApiError(404, 'Role not found');

  // 3) System roles (DEFAULT_ADMIN, DEFAULT_MEDICAL_REP, etc.) cannot be deleted
  if (role.isSystem) {
    throw new ApiError(400, 'System roles cannot be deleted');
  }

  // 4–5) Must not remove a role that is still assigned — avoids dangling roleId
  const userCount = await User.countDocuments({ companyId: cid, roleId: id, isDeleted: { $ne: true } });
  if (userCount > 0) {
    throw new ApiError(
      400,
      `Role is assigned to ${userCount} user(s). Reassign them before deleting.`
    );
  }

  // 6) Safe soft delete
  await role.softDelete(reqUser.userId);
  await auditService.log({
    companyId: cid,
    userId: reqUser.userId,
    action: 'role.delete',
    entityType: 'Role',
    entityId: role._id,
    changes: { after: { isDeleted: true } }
  });
  return role;
};

/** Idempotent: ensures DEFAULT_ADMIN + DEFAULT_MEDICAL_REP exist. Safe to call from list, login, getMe. */
const ensureDefaultRolesForCompany = (companyId) => seedDefaultRolesForCompany(companyId, {});

module.exports = {
  seedDefaultRolesForCompany,
  ensureDefaultRolesForCompany,
  toCompanyObjectId,
  list,
  getById,
  create,
  update,
  remove,
  DEFAULT_MEDICAL_REP_PERMISSIONS
};
