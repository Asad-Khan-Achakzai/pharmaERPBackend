const mongoose = require('mongoose');
const Doctor = require('../models/Doctor');
const Pharmacy = require('../models/Pharmacy');
const Territory = require('../models/Territory');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const auditService = require('./audit.service');
const mrepOwnership = require('./mrepOwnership.service');
const mediaAttach = require('./media.attach');

const doctorOwnershipAudit = require('./doctorOwnershipAudit.service');

/** Attach a transient signed imageUrl to doctor docs from MediaAsset (source of truth). */
async function withDoctorImages(companyId, docs) {
  const arr = Array.isArray(docs) ? docs : [docs];
  const ids = arr.filter(Boolean).map((d) => String(d._id));
  const images = await mediaAttach.resolveEntityImages({ companyId, resource: 'doctors', ids });
  const decorate = (d) => {
    if (!d) return d;
    const obj = typeof d.toObject === 'function' ? d.toObject() : d;
    const img = images.get(String(obj._id));
    obj.imageUrl = img ? img.url : null;
    return obj;
  };
  return Array.isArray(docs) ? arr.map(decorate) : decorate(docs);
}

const toObjectIdOrNull = (v) => {
  if (v == null || v === '') return null;
  if (!mongoose.Types.ObjectId.isValid(v)) {
    throw new ApiError(400, 'Invalid id format');
  }
  return new mongoose.Types.ObjectId(v);
};

const resolveTerritory = async (companyId, territoryId) => {
  const oid = toObjectIdOrNull(territoryId);
  if (!oid) return null;
  const t = await Territory.findOne({ _id: oid, companyId, isDeleted: { $ne: true } })
    .select('_id')
    .lean();
  if (!t) throw new ApiError(404, 'Territory not found in this company');
  return oid;
};

const resolveAssignedRep = async (companyId, repId) => {
  const oid = toObjectIdOrNull(repId);
  if (!oid) return null;
  const u = await User.findOne({ _id: oid, companyId, isDeleted: { $ne: true } })
    .select('_id isActive')
    .lean();
  if (!u) throw new ApiError(404, 'Rep user not found in this company');
  if (u.isActive === false) throw new ApiError(400, 'Rep user is inactive');
  return oid;
};

const normalizeDoctorPayload = (data) => {
  const o = { ...data };
  if (Object.prototype.hasOwnProperty.call(o, 'pharmacyId') && (o.pharmacyId === '' || o.pharmacyId === undefined)) {
    o.pharmacyId = null;
  }
  if (Object.prototype.hasOwnProperty.call(o, 'gender') && (o.gender === null || o.gender === undefined)) {
    o.gender = '';
  }
  if (Object.prototype.hasOwnProperty.call(o, 'patientCount')) {
    if (o.patientCount === '' || o.patientCount === null || Number.isNaN(Number(o.patientCount))) {
      o.patientCount = null;
    } else {
      o.patientCount = Number(o.patientCount);
    }
  }
  if (Object.prototype.hasOwnProperty.call(o, 'monthlyVisitTarget')) {
    if (o.monthlyVisitTarget === '' || o.monthlyVisitTarget === null || Number.isNaN(Number(o.monthlyVisitTarget))) {
      o.monthlyVisitTarget = null;
    } else {
      o.monthlyVisitTarget = Number(o.monthlyVisitTarget);
    }
  }
  if (Object.prototype.hasOwnProperty.call(o, 'tier')) {
    o.tier = o.tier == null ? null : String(o.tier).trim() || null;
  }
  if (Object.prototype.hasOwnProperty.call(o, 'territoryId') && (o.territoryId === '' || o.territoryId === undefined)) {
    o.territoryId = null;
  }
  if (Object.prototype.hasOwnProperty.call(o, 'assignedRepId') && (o.assignedRepId === '' || o.assignedRepId === undefined)) {
    o.assignedRepId = null;
  }
  return o;
};

/**
 * Resolve / validate the assignment-related foreign keys (territoryId, assignedRepId) into
 * ObjectIds and confirm they belong to the same company. Mutates `payload` in-place.
 */
const applyAssignmentRefs = async (companyId, payload) => {
  if (Object.prototype.hasOwnProperty.call(payload, 'territoryId')) {
    payload.territoryId = await resolveTerritory(companyId, payload.territoryId);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'assignedRepId')) {
    payload.assignedRepId = await resolveAssignedRep(companyId, payload.assignedRepId);
  }
};

const list = async (companyId, query, timeZone = "UTC", opts = {}) => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (query.pharmacyId) filter.pharmacyId = query.pharmacyId;

  let territoryFilter = null;
  if (query.underTerritoryId && mongoose.Types.ObjectId.isValid(query.underTerritoryId)) {
    const brickIds = await mrepOwnership.brickIdsForTerritoryNode(companyId, query.underTerritoryId);
    if (!brickIds.length) {
      return { docs: [], total: 0, page, limit };
    }
    territoryFilter = { $in: brickIds };
  } else if (query.territoryId && mongoose.Types.ObjectId.isValid(query.territoryId)) {
    territoryFilter = new mongoose.Types.ObjectId(query.territoryId);
  }
  if (territoryFilter !== null) {
    filter.territoryId = territoryFilter;
  }
  if (query.assignedRepId && mongoose.Types.ObjectId.isValid(query.assignedRepId)) {
    filter.assignedRepId = new mongoose.Types.ObjectId(query.assignedRepId);
  }
  /**
   * Manager team scope (Phase 2A): when `opts.scopedUserIds` is an array, only return
   * doctors explicitly assigned to a user in the subtree. Doctors with no `assignedRepId`
   * are intentionally excluded — managers should treat unassigned doctors as a separate
   * "Unassigned" view (filterable via `?assignedRepId=null` later if needed).
   */
  if (Array.isArray(opts.scopedUserIds)) {
    if (opts.scopedUserIds.length === 0) {
      // Empty subtree -> empty result, but stay consistent with normal pagination shape.
      return { docs: [], total: 0, page, limit };
    }
    filter.assignedRepId = { $in: opts.scopedUserIds };
  }
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { specialization: { $regex: rx, $options: 'i' } },
      { doctorCode: { $regex: rx, $options: 'i' } },
      { city: { $regex: rx, $options: 'i' } },
      { zone: { $regex: rx, $options: 'i' } },
      { mobileNo: { $regex: rx, $options: 'i' } },
      { phone: { $regex: rx, $options: 'i' } },
      { qualification: { $regex: rx, $options: 'i' } },
      { designation: { $regex: rx, $options: 'i' } },
      { pmdcRegistration: { $regex: rx, $options: 'i' } }
    ];
  }
  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  applyCreatedByFromQuery(filter, query);
  const [docs, total] = await Promise.all([
    Doctor.find(filter)
      .populate('pharmacyId', 'name city')
      .populate('territoryId', 'name code kind')
      .populate('assignedRepId', 'name email')
      .sort(sort)
      .skip(skip)
      .limit(limit),
    Doctor.countDocuments(filter)
  ]);
  const withUrls = await withDoctorImages(companyId, docs);
  return { docs: withUrls, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const { assetId, ...rest } = data;
  const payload = normalizeDoctorPayload(rest);
  if (payload.pharmacyId) {
    const pharmacy = await Pharmacy.findOne({ _id: payload.pharmacyId, companyId, isActive: true });
    if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');
  }
  await applyAssignmentRefs(companyId, payload);
  const doctor = await Doctor.create({ ...payload, companyId, createdBy: reqUser.userId });
  if (assetId) {
    await mediaAttach.attachEntityImage({
      companyId,
      uploadedBy: reqUser.userId,
      resource: 'doctors',
      id: doctor._id,
      assetId
    });
  }
  await auditService.log({ companyId, userId: reqUser.userId, action: 'doctor.create', entityType: 'Doctor', entityId: doctor._id, changes: { after: doctor.toObject() } });
  await doctorOwnershipAudit.recordAssignmentChanges({
    companyId,
    doctorId: doctor._id,
    changedByUserId: reqUser.userId,
    before: { territoryId: null, assignedRepId: null },
    after: { territoryId: doctor.territoryId, assignedRepId: doctor.assignedRepId }
  });
  return withDoctorImages(companyId, doctor);
};

const getById = async (companyId, id) => {
  const doctor = await Doctor.findOne({ _id: id, companyId })
    .populate('pharmacyId', 'name city address')
    .populate('territoryId', 'name code kind materializedPath')
    .populate('assignedRepId', 'name email');
  if (!doctor) throw new ApiError(404, 'Doctor not found');
  const o = doctor.toObject();
  o.mrepOwnership = mrepOwnership.summarizeDoctorDocument(o);
  const image = await mediaAttach.resolveEntityImage({ companyId, resource: 'doctors', id });
  o.imageUrl = image ? image.url : null;
  return o;
};

const update = async (companyId, id, data, reqUser) => {
  const doctor = await Doctor.findOne({ _id: id, companyId });
  if (!doctor) throw new ApiError(404, 'Doctor not found');
  const { assetId, ...rest } = data;
  const patch = normalizeDoctorPayload(rest);
  if (patch.pharmacyId !== undefined && patch.pharmacyId) {
    const pharmacy = await Pharmacy.findOne({ _id: patch.pharmacyId, companyId, isActive: true });
      if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');
  }
  await applyAssignmentRefs(companyId, patch);
  const before = doctor.toObject();
  Object.assign(doctor, { ...patch, updatedBy: reqUser.userId });
  await doctor.save();
  if (assetId) {
    await mediaAttach.attachEntityImage({
      companyId,
      uploadedBy: reqUser.userId,
      resource: 'doctors',
      id: doctor._id,
      assetId
    });
  }
  await auditService.log({ companyId, userId: reqUser.userId, action: 'doctor.update', entityType: 'Doctor', entityId: doctor._id, changes: { before, after: doctor.toObject() } });
  await doctorOwnershipAudit.recordAssignmentChanges({
    companyId,
    doctorId: doctor._id,
    changedByUserId: reqUser.userId,
    before: { territoryId: before.territoryId, assignedRepId: before.assignedRepId },
    after: { territoryId: doctor.territoryId, assignedRepId: doctor.assignedRepId }
  });
  return withDoctorImages(companyId, doctor);
};

/**
 * PATCH /doctors/:id/assign — focused endpoint for managers (permission `doctors.assign`).
 * Updates only territoryId/assignedRepId/monthlyVisitTarget/tier without touching the rest
 * of the doctor record. Each field is optional; pass `null` (or empty string) to clear.
 */
const assign = async (companyId, id, data, reqUser) => {
  const doctor = await Doctor.findOne({ _id: id, companyId });
  if (!doctor) throw new ApiError(404, 'Doctor not found');

  const allowed = ['territoryId', 'assignedRepId', 'monthlyVisitTarget', 'tier'];
  const patch = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(data, key)) patch[key] = data[key];
  }
  if (!Object.keys(patch).length) {
    throw new ApiError(400, 'No assignment fields provided');
  }

  const normalized = normalizeDoctorPayload(patch);
  await applyAssignmentRefs(companyId, normalized);

  const before = {
    territoryId: doctor.territoryId,
    assignedRepId: doctor.assignedRepId,
    monthlyVisitTarget: doctor.monthlyVisitTarget,
    tier: doctor.tier
  };
  Object.assign(doctor, normalized, { updatedBy: reqUser.userId });
  await doctor.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'doctor.assign',
    entityType: 'Doctor',
    entityId: doctor._id,
    changes: {
      before,
      after: {
        territoryId: doctor.territoryId,
        assignedRepId: doctor.assignedRepId,
        monthlyVisitTarget: doctor.monthlyVisitTarget,
        tier: doctor.tier
      }
    }
  });
  await doctorOwnershipAudit.recordAssignmentChanges({
    companyId,
    doctorId: doctor._id,
    changedByUserId: reqUser.userId,
    before: { territoryId: before.territoryId, assignedRepId: before.assignedRepId },
    after: { territoryId: doctor.territoryId, assignedRepId: doctor.assignedRepId }
  });
  return doctor;
};

const remove = async (companyId, id, reqUser) => {
  const doctor = await Doctor.findOne({ _id: id, companyId });
  if (!doctor) throw new ApiError(404, 'Doctor not found');
  await doctor.softDelete(reqUser.userId);
  await auditService.log({ companyId, userId: reqUser.userId, action: 'doctor.delete', entityType: 'Doctor', entityId: doctor._id, changes: { after: { isActive: false } } });
  return doctor;
};

const listOwnershipHistory = async (companyId, doctorId, query = {}) => {
  if (!mongoose.Types.ObjectId.isValid(doctorId)) {
    throw new ApiError(400, 'Invalid doctor id');
  }
  const doc = await Doctor.findOne({ _id: doctorId, companyId }).select('_id').lean();
  if (!doc) throw new ApiError(404, 'Doctor not found');
  const limit = query.limit != null ? Number(query.limit) : 50;
  return doctorOwnershipAudit.listForDoctor(companyId, doctorId, { limit });
};

module.exports = { list, create, getById, update, remove, assign, listOwnershipHistory };
