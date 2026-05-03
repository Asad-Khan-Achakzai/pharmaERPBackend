/**
 * Tenant-scoped lookup rows for form dropdowns (auth + companyScope only; no resource.view).
 * Returns data required for UIs (e.g. order create needs TP/discount fields), not full admin records.
 */
const Distributor = require('../models/Distributor');
const Product = require('../models/Product');
const Pharmacy = require('../models/Pharmacy');
const Doctor = require('../models/Doctor');
const User = require('../models/User');
const Supplier = require('../models/Supplier');
const { escapeRegex, qScalar } = require('../utils/listQuery');

const LOOKUP_MAX = Math.min(100, Number(process.env.LOOKUP_MAX) || 100);

const clampLimit = (q) => {
  const n = parseInt(String(q?.limit || '100'), 10);
  if (Number.isNaN(n) || n < 1) return LOOKUP_MAX;
  return Math.min(n, LOOKUP_MAX);
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
      { composition: { $regex: rx, $options: 'i' } }
    ];
  }
  const rows = await Product.find(filter)
    .select('name composition mrp tp casting')
    .sort({ name: 1 })
    .limit(limit)
    .lean();
  return rows.map((p) => ({
    _id: p._id,
    name: p.name,
    composition: p.composition,
    mrp: p.mrp,
    tp: p.tp,
    casting: p.casting
  }));
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
  return rows.map((p) => ({
    _id: p._id,
    name: p.name,
    discountOnTP: p.discountOnTP,
    bonusScheme: p.bonusScheme
  }));
};

const doctors = async (companyId, query = {}) => {
  const limit = clampLimit(query);
  const base = { companyId };
  const f = applyActive(base, query);
  if (query.pharmacyId) f.pharmacyId = query.pharmacyId;
  const searchTerm = qScalar(query.search);
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    f.name = { $regex: rx, $options: 'i' };
  }
  const rows = await Doctor.find(f)
    .select('name pharmacyId')
    .sort({ name: 1 })
    .limit(limit)
    .lean();
  return rows.map((d) => ({
    _id: d._id,
    name: d.name,
    pharmacyId: d.pharmacyId
  }));
};

/** Same semantics as order assignable reps: active company users (minimal fields for dropdowns). */
const assignableUsers = async (companyId, query = {}) => {
  const limit = clampLimit(query);
  const filter = { companyId, isActive: true };
  const searchTerm = qScalar(query.search);
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { email: { $regex: rx, $options: 'i' } }
    ];
  }
  const rows = await User.find(filter)
    .select('name email role')
    .sort({ name: 1 })
    .limit(limit)
    .lean();
  return rows.map((u) => ({
    _id: u._id,
    name: u.name,
    email: u.email,
    role: u.role
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
