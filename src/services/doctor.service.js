const Doctor = require('../models/Doctor');
const Pharmacy = require('../models/Pharmacy');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const auditService = require('./audit.service');

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
  return o;
};

const list = async (companyId, query, timeZone = "UTC") => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (query.pharmacyId) filter.pharmacyId = query.pharmacyId;
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
    Doctor.find(filter).populate('pharmacyId', 'name city').sort(sort).skip(skip).limit(limit),
    Doctor.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const payload = normalizeDoctorPayload(data);
  if (payload.pharmacyId) {
    const pharmacy = await Pharmacy.findOne({ _id: payload.pharmacyId, companyId, isActive: true });
    if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');
  }
  const doctor = await Doctor.create({ ...payload, companyId, createdBy: reqUser.userId });
  await auditService.log({ companyId, userId: reqUser.userId, action: 'doctor.create', entityType: 'Doctor', entityId: doctor._id, changes: { after: doctor.toObject() } });
  return doctor;
};

const getById = async (companyId, id) => {
  const doctor = await Doctor.findOne({ _id: id, companyId }).populate('pharmacyId', 'name city address');
  if (!doctor) throw new ApiError(404, 'Doctor not found');
  return doctor;
};

const update = async (companyId, id, data, reqUser) => {
  const doctor = await Doctor.findOne({ _id: id, companyId });
  if (!doctor) throw new ApiError(404, 'Doctor not found');
  const patch = normalizeDoctorPayload(data);
  if (patch.pharmacyId !== undefined && patch.pharmacyId) {
    const pharmacy = await Pharmacy.findOne({ _id: patch.pharmacyId, companyId, isActive: true });
      if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');
  }
  const before = doctor.toObject();
  Object.assign(doctor, { ...patch, updatedBy: reqUser.userId });
  await doctor.save();
  await auditService.log({ companyId, userId: reqUser.userId, action: 'doctor.update', entityType: 'Doctor', entityId: doctor._id, changes: { before, after: doctor.toObject() } });
  return doctor;
};

const remove = async (companyId, id, reqUser) => {
  const doctor = await Doctor.findOne({ _id: id, companyId });
  if (!doctor) throw new ApiError(404, 'Doctor not found');
  await doctor.softDelete(reqUser.userId);
  await auditService.log({ companyId, userId: reqUser.userId, action: 'doctor.delete', entityType: 'Doctor', entityId: doctor._id, changes: { after: { isActive: false } } });
  return doctor;
};

module.exports = { list, create, getById, update, remove };
