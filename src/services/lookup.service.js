/**
 * Tenant-scoped lookup rows for form dropdowns (auth + companyScope only; no resource.view).
 * Returns data required for UIs (e.g. order create needs TP/discount fields), not full admin records.
 */
const mongoose = require('mongoose');
const Distributor = require('../models/Distributor');
const Product = require('../models/Product');
const Pharmacy = require('../models/Pharmacy');
const Doctor = require('../models/Doctor');
const User = require('../models/User');
const Supplier = require('../models/Supplier');
const mrepOwnership = require('./mrepOwnership.service');
const mediaAttach = require('./media.attach');
const { escapeRegex, qScalar } = require('../utils/listQuery');
const { ADMIN_ACCESS } = require('../constants/rbac');
const { userHasTenantWideAccess } = require('../utils/effectivePermissions');
const { resolveSubtreeUserIds } = require('../utils/teamScope');

const LOOKUP_MAX = Math.min(100, Number(process.env.LOOKUP_MAX) || 100);

const clampLimit = (q) => {
  const n = parseInt(String(q?.limit || '100'), 10);
  if (Number.isNaN(n) || n < 1) return LOOKUP_MAX;
  return Math.min(n, LOOKUP_MAX);
};

/**
 * Decorate lookup rows with a transient signed `imageUrl` from MediaAsset
 * (source of truth). Batched (single query + one signed URL per asset) so
 * dropdowns/pickers can show entity thumbnails without N+1 lookups.
 */
const attachLookupImages = async (companyId, resource, rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const ids = rows.map((r) => String(r._id));
  const images = await mediaAttach.resolveEntityImages({ companyId, resource, ids });
  for (const r of rows) {
    const img = images.get(String(r._id));
    r.imageUrl = img ? img.url : null;
  }
  return rows;
};

/** @param {import('mongoose').FilterQuery} base */
const applyActive = (base, q) => {
  if (q && (q.isActive === 'true' || q.isActive === 'false')) {
    return { ...base, isActive: q.isActive === 'true' };
  }
  return { ...base, isActive: true };
};

const distributors = async (companyId, query = {}) => {
  const limit = clampLimit(query);
  const filter = applyActive({ companyId }, query);
  const searchTerm = qScalar(query.search);
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.name = { $regex: rx, $options: 'i' };
  }
  const rows = await Distributor.find(filter)
    .select('name discountOnTP commissionPercentOnTP')
    .sort({ name: 1 })
    .limit(limit)
    .lean();
  return rows.map((d) => ({
    _id: d._id,
    name: d.name,
    discountOnTP: d.discountOnTP,
    commissionPercentOnTP: d.commissionPercentOnTP
  }));
};

const products = async (companyId, query = {}) => {
  const limit = clampLimit(query);
  const filter = applyActive({ companyId }, query);
  const searchTerm = qScalar(query.search);
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { composition: { $regex: rx, $options: 'i' } },
      { genericName: { $regex: rx, $options: 'i' } },
      { sku: { $regex: rx, $options: 'i' } }
    ];
  }
  const rows = await Product.find(filter)
    .select('name composition genericName sku packSize mrp tp casting isSampleEligible')
    .sort({ name: 1 })
    .limit(limit)
    .lean();
  return attachLookupImages(
    companyId,
    'products',
    rows.map((p) => ({
      _id: p._id,
      name: p.name,
      composition: p.composition,
      genericName: p.genericName,
      sku: p.sku,
      packSize: p.packSize,
      mrp: p.mrp,
      tp: p.tp,
      casting: p.casting,
      isSampleEligible: p.isSampleEligible
    }))
  );
};

const pharmacies = async (companyId, query = {}) => {
  const limit = clampLimit(query);
  const filter = applyActive({ companyId }, query);
  const searchTerm = qScalar(query.search);
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { city: { $regex: rx, $options: 'i' } }
    ];
  }
  const rows = await Pharmacy.find(filter)
    .select('name discountOnTP bonusScheme')
    .sort({ name: 1 })
    .limit(limit)
    .lean();
  return attachLookupImages(
    companyId,
    'pharmacies',
    rows.map((p) => ({
      _id: p._id,
      name: p.name,
      discountOnTP: p.discountOnTP,
      bonusScheme: p.bonusScheme
    }))
  );
};

const doctors = async (companyId, query = {}) => {
  const limit = clampLimit(query);
  const base = { companyId };
  const f = applyActive(base, query);
  if (query.pharmacyId) f.pharmacyId = query.pharmacyId;

  let territoryFilter = null;
  if (query.underTerritoryId && mongoose.Types.ObjectId.isValid(query.underTerritoryId)) {
    const brickIds = await mrepOwnership.brickIdsForTerritoryNode(companyId, query.underTerritoryId);
    if (!brickIds.length) return [];
    territoryFilter = { $in: brickIds };
  } else if (query.territoryId && mongoose.Types.ObjectId.isValid(query.territoryId)) {
    territoryFilter = new mongoose.Types.ObjectId(query.territoryId);
  }
  if (territoryFilter !== null) {
    f.territoryId = territoryFilter;
  }

  if (query.assignedRepId && mongoose.Types.ObjectId.isValid(query.assignedRepId)) {
    const { resolveSubtreeUserIds } = require('../utils/teamScope');
    const ownershipUserIds = await resolveSubtreeUserIds(companyId, query.assignedRepId, {
      includeSelf: true,
      activeOnly: true
    });
    if (!ownershipUserIds.length) return [];
    const ownershipOr = await mrepOwnership.ownershipOrClausesForUsers(companyId, ownershipUserIds);
    if (!ownershipOr.length) return [];
    f.$and = [...(f.$and || []), { $or: ownershipOr }];
  }

  const searchTerm = qScalar(query.search);
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    f.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { specialization: { $regex: rx, $options: 'i' } },
      { doctorBrick: { $regex: rx, $options: 'i' } },
      { doctorCode: { $regex: rx, $options: 'i' } },
      { city: { $regex: rx, $options: 'i' } },
      { zone: { $regex: rx, $options: 'i' } }
    ];
  }
  const rows = await Doctor.find(f)
    .select('name pharmacyId specialization doctorBrick doctorCode city zone territoryId assignedRepId')
    .populate('territoryId', 'name code kind')
    .sort({ name: 1 })
    .limit(limit)
    .lean();
  return attachLookupImages(
    companyId,
    'doctors',
    rows.map((d) => ({
      _id: d._id,
      name: d.name,
      pharmacyId: d.pharmacyId,
      specialization: d.specialization ?? null,
      doctorBrick: d.doctorBrick ?? null,
      doctorCode: d.doctorCode ?? null,
      city: d.city ?? null,
      zone: d.zone ?? null,
      territoryId: d.territoryId ?? null,
      assignedRepId: d.assignedRepId ?? null
    }))
  );
};

/** Same semantics as order assignable reps: active company users (minimal fields for dropdowns). */
const assignableUsers = async (companyId, query = {}, reqUser = null) => {
  const limit = clampLimit(query);
  const filter = { companyId, isActive: true };
  const coVisitOwnerId = qScalar(query.forCoVisitOwnerId);
  if (coVisitOwnerId && mongoose.Types.ObjectId.isValid(coVisitOwnerId)) {
    // Co-visit picker: all active company users except the visit owner.
    filter._id = { $ne: new mongoose.Types.ObjectId(coVisitOwnerId) };
  } else {
  const scopeTeam = qScalar(query.scope) === 'team';
  if (scopeTeam && reqUser && !userHasTenantWideAccess(reqUser)) {
    const subtreeIds = await resolveSubtreeUserIds(companyId, reqUser.userId, {
      includeSelf: true,
      activeOnly: true
    });
    filter._id = subtreeIds.length ? { $in: subtreeIds } : { $in: [] };
  }
  }
  const searchTerm = qScalar(query.search);
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { email: { $regex: rx, $options: 'i' } }
    ];
  }
  const rows = await User.find(filter)
    .select('name email role roleId')
    .populate('roleId', 'code name permissions')
    .sort({ name: 1 })
    .limit(limit)
    .lean();
  return rows.map((u) => ({
    _id: u._id,
    name: u.name,
    email: u.email,
    role: u.role,
    roleCode: u.roleId?.code ?? null,
    roleName: u.roleId?.name ?? null,
    isAdminCapable:
      Array.isArray(u.roleId?.permissions) && u.roleId.permissions.includes(ADMIN_ACCESS)
  }));
};

const suppliers = async (companyId, query = {}) => {
  const limit = clampLimit(query);
  const filter = { companyId, isDeleted: { $ne: true } };
  if (query && (query.isActive === 'true' || query.isActive === 'false')) {
    filter.isActive = query.isActive === 'true';
  } else {
    filter.isActive = true;
  }
  const searchTerm = qScalar(query.search);
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { email: { $regex: rx, $options: 'i' } },
      { phone: { $regex: rx, $options: 'i' } }
    ];
  }
  const rows = await Supplier.find(filter)
    .select('name phone email')
    .sort({ name: 1 })
    .limit(limit)
    .lean();
  return rows.map((s) => ({
    _id: s._id,
    name: s.name,
    phone: s.phone,
    email: s.email
  }));
};

module.exports = {
  LOOKUP_MAX,
  distributors,
  products,
  pharmacies,
  doctors,
  assignableUsers,
  suppliers
};
