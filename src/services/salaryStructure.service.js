const SalaryStructure = require('../models/SalaryStructure');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const auditService = require('./audit.service');

const list = async (companyId, query) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId };
  if (query.employeeId) filter.employeeId = query.employeeId;
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true' || query.isActive === true;

  const [docs, total] = await Promise.all([
    SalaryStructure.find(filter)
      .populate('employeeId', 'name email role')
      .sort(sort)
      .skip(skip)
      .limit(limit),
    SalaryStructure.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const getById = async (companyId, id) => {
  const doc = await SalaryStructure.findOne({ _id: id, companyId }).populate('employeeId', 'name email role');
  if (!doc) throw new ApiError(404, 'Salary structure not found');
  return doc;
};

/** Single active structure for employee (business rule: at most one isActive). */
const getActiveForEmployee = async (companyId, employeeId) => {
  return SalaryStructure.findOne({ companyId, employeeId, isActive: true }).populate('employeeId', 'name email role');
};

const create = async (companyId, data, reqUser) => {
  const employee = await User.findOne({ _id: data.employeeId, companyId });
  if (!employee) throw new ApiError(404, 'Employee not found');

  await SalaryStructure.updateMany(
    { companyId, employeeId: data.employeeId, isActive: true },
    { $set: { isActive: false, updatedBy: reqUser.userId } }
  );

  const doc = await SalaryStructure.create({
    ...data,
    companyId,
    createdBy: reqUser.userId,
    updatedBy: reqUser.userId
  });

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'salaryStructure.create',
    entityType: 'SalaryStructure',
    entityId: doc._id,
    changes: { after: doc.toObject() }
  });

  return doc.populate('employeeId', 'name email role');
};

const update = async (companyId, id, data, reqUser) => {
  const doc = await SalaryStructure.findOne({ _id: id, companyId });
  if (!doc) throw new ApiError(404, 'Salary structure not found');
  if (!doc.isActive) throw new ApiError(400, 'Cannot edit inactive salary structure; create a new version instead');

  const before = doc.toObject();
  Object.assign(doc, data, { updatedBy: reqUser.userId });
  await doc.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'salaryStructure.update',
    entityType: 'SalaryStructure',
    entityId: doc._id,
    changes: { before, after: doc.toObject() }
  });

  return doc.populate('employeeId', 'name email role');
};

module.exports = { list, getById, getActiveForEmployee, create, update };
