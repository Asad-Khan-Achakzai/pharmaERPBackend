const Doctor = require('../models/Doctor');
const Pharmacy = require('../models/Pharmacy');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const auditService = require('./audit.service');

const list = async (companyId, query) => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const filter = { companyId };
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (query.pharmacyId) filter.pharmacyId = query.pharmacyId;
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { specialization: { $regex: search, $options: 'i' } }
    ];
  }
  const [docs, total] = await Promise.all([
    Doctor.find(filter).populate('pharmacyId', 'name city').sort(sort).skip(skip).limit(limit),
    Doctor.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const pharmacy = await Pharmacy.findOne({ _id: data.pharmacyId, companyId, isActive: true });
  if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');
  const doctor = await Doctor.create({ ...data, companyId, createdBy: reqUser.userId });
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
  if (data.pharmacyId) {
    const pharmacy = await Pharmacy.findOne({ _id: data.pharmacyId, companyId, isActive: true });
    if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');
  }
  const before = doctor.toObject();
  Object.assign(doctor, { ...data, updatedBy: reqUser.userId });
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
