const SalaryStructure = require('../models/SalaryStructure');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const auditService = require('./audit.service');
const { normalizeProductPackIncentives } = require('../utils/productPackIncentiveNormalize');
const {
  escapeRegex,
  qScalar,
  applyCreatedAtRangeFromQuery,
  applyCreatedByFromQuery
} = require('../utils/listQuery');

const STRUCTURE_POPULATE = [{ path: 'productPackIncentives.productId', select: 'name composition' }];

const LEGACY_STRUCTURE_FILTER = {
  $or: [{ isTemplate: false }, { isTemplate: { $exists: false } }]
};

const assertTemplate = (doc) => {
  if (!doc || doc.isTemplate === false) {
    throw new ApiError(404, 'Salary structure template not found');
  }
};

const attachAssignedCounts = async (companyId, docs) => {
  if (!docs.length) return docs;
  const ids = docs.map((d) => d._id);
  const counts = await User.aggregate([
    {
      $match: {
        companyId,
        salaryStructureId: { $in: ids },
        isDeleted: { $ne: true }
      }
    },
    { $group: { _id: '$salaryStructureId', count: { $sum: 1 } } }
  ]);
  const countMap = Object.fromEntries(counts.map((c) => [String(c._id), c.count]));
  return docs.map((d) => {
    const plain = typeof d.toObject === 'function' ? d.toObject() : { ...d };
    plain.assignedEmployeeCount = countMap[String(d._id)] || 0;
    return plain;
  });
};

const list = async (companyId, query, timeZone = 'UTC') => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };

  const templatesOnly = query.templatesOnly !== 'false' && query.templatesOnly !== false;
  if (templatesOnly) {
    filter.isTemplate = true;
  } else if (query.employeeId) {
    filter.employeeId = query.employeeId;
  }

  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true' || query.isActive === true;

  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    if (templatesOnly) {
      filter.name = { $regex: rx, $options: 'i' };
    } else if (!query.employeeId) {
      const emps = await User.find({
        companyId,
        name: { $regex: rx, $options: 'i' },
        isDeleted: { $ne: true }
      })
        .select('_id')
        .lean()
        .limit(80);
      const eids = emps.map((e) => e._id);
      filter.$or = [{ name: { $regex: rx, $options: 'i' } }, ...(eids.length ? [{ employeeId: { $in: eids } }] : [])];
    }
  }

  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  applyCreatedByFromQuery(filter, query);

  const [rawDocs, total] = await Promise.all([
    SalaryStructure.find(filter).populate(STRUCTURE_POPULATE).sort(sort).skip(skip).limit(limit),
    SalaryStructure.countDocuments(filter)
  ]);

  const docs = templatesOnly ? await attachAssignedCounts(companyId, rawDocs) : rawDocs;
  return { docs, total, page, limit };
};

const getById = async (companyId, id) => {
  const doc = await SalaryStructure.findOne({ _id: id, companyId }).populate(STRUCTURE_POPULATE);
  if (!doc) throw new ApiError(404, 'Salary structure not found');
  if (doc.isTemplate !== false) {
    const [enriched] = await attachAssignedCounts(companyId, [doc]);
    return enriched;
  }
  return doc;
};

/** Resolve the salary structure used for payroll for an employee (template assignment with legacy fallback). */
const getStructureForEmployee = async (companyId, employeeId) => {
  const user = await User.findOne({ _id: employeeId, companyId }).select('salaryStructureId').lean();
  if (user?.salaryStructureId) {
    const tpl = await SalaryStructure.findOne({
      _id: user.salaryStructureId,
      companyId,
      isTemplate: true,
      isActive: true
    }).populate(STRUCTURE_POPULATE);
    if (tpl) return tpl;
  }

  return SalaryStructure.findOne({
    companyId,
    employeeId,
    isActive: true,
    ...LEGACY_STRUCTURE_FILTER
  }).populate(STRUCTURE_POPULATE);
};

/** @deprecated Use getStructureForEmployee — kept for route alias. */
const getActiveForEmployee = getStructureForEmployee;

const listAssignedEmployees = async (companyId, structureId) => {
  const doc = await SalaryStructure.findOne({ _id: structureId, companyId });
  assertTemplate(doc);

  return User.find({
    companyId,
    salaryStructureId: structureId,
    isDeleted: { $ne: true }
  })
    .select('name email role employeeCode isActive')
    .sort({ name: 1 })
    .lean();
};

const assignEmployees = async (companyId, structureId, employeeIds, reqUser) => {
  const structure = await SalaryStructure.findOne({ _id: structureId, companyId });
  assertTemplate(structure);
  if (!structure.isActive) throw new ApiError(400, 'Cannot assign employees to an archived template');

  const ids = [...new Set((employeeIds || []).map(String).filter(Boolean))];
  if (!ids.length) throw new ApiError(400, 'employeeIds is required');

  const users = await User.find({ _id: { $in: ids }, companyId, isDeleted: { $ne: true } }).select('_id');
  if (users.length !== ids.length) throw new ApiError(400, 'One or more employees not found');

  const now = new Date();
  await User.updateMany(
    { _id: { $in: ids }, companyId },
    { $set: { salaryStructureId: structureId, salaryStructureAssignedAt: now, updatedBy: reqUser.userId } }
  );

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'salaryStructure.assign',
    entityType: 'SalaryStructure',
    entityId: structureId,
    changes: { employeeIds: ids }
  });

  return { assigned: ids.length };
};

const unassignEmployees = async (companyId, structureId, employeeIds, reqUser) => {
  const structure = await SalaryStructure.findOne({ _id: structureId, companyId });
  assertTemplate(structure);

  const ids = [...new Set((employeeIds || []).map(String).filter(Boolean))];
  if (!ids.length) throw new ApiError(400, 'employeeIds is required');

  const result = await User.updateMany(
    { _id: { $in: ids }, companyId, salaryStructureId: structureId },
    { $set: { salaryStructureId: null, salaryStructureAssignedAt: null, updatedBy: reqUser.userId } }
  );

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'salaryStructure.unassign',
    entityType: 'SalaryStructure',
    entityId: structureId,
    changes: { employeeIds: ids, modifiedCount: result.modifiedCount }
  });

  return { unassigned: result.modifiedCount };
};

const create = async (companyId, data, reqUser) => {
  const name = String(data.name || '').trim();
  if (!name) throw new ApiError(400, 'Template name is required');

  const dup = await SalaryStructure.findOne({ companyId, name, isTemplate: true, isDeleted: { $ne: true } });
  if (dup) throw new ApiError(409, 'A salary structure template with this name already exists');

  const productPackIncentives = normalizeProductPackIncentives(data.productPackIncentives);

  const doc = await SalaryStructure.create({
    companyId,
    name,
    description: data.description ? String(data.description).trim() : '',
    code: data.code ? String(data.code).trim() : '',
    isTemplate: true,
    basicSalary: data.basicSalary,
    dailyAllowance: data.dailyAllowance ?? 0,
    allowances: data.allowances ?? [],
    deductions: data.deductions ?? [],
    commission: data.commission ?? { type: 'percentage', value: 0 },
    productPackIncentives,
    isActive: data.isActive !== false,
    extensions: data.extensions,
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

  const [enriched] = await attachAssignedCounts(companyId, [doc]);
  return enriched;
};

const update = async (companyId, id, data, reqUser) => {
  const doc = await SalaryStructure.findOne({ _id: id, companyId });
  if (!doc) throw new ApiError(404, 'Salary structure not found');

  if (doc.isTemplate === false) {
    throw new ApiError(400, 'Legacy employee-bound structures cannot be edited; create a template instead');
  }

  const before = doc.toObject();

  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw new ApiError(400, 'Template name cannot be empty');
    const dup = await SalaryStructure.findOne({
      companyId,
      name,
      isTemplate: true,
      _id: { $ne: id },
      isDeleted: { $ne: true }
    });
    if (dup) throw new ApiError(409, 'A salary structure template with this name already exists');
    doc.name = name;
  }

  if (data.description !== undefined) doc.description = String(data.description).trim();
  if (data.code !== undefined) doc.code = String(data.code).trim();
  if (data.basicSalary !== undefined) doc.basicSalary = data.basicSalary;
  if (data.dailyAllowance !== undefined) doc.dailyAllowance = data.dailyAllowance;
  if (data.allowances !== undefined) doc.allowances = data.allowances;
  if (data.deductions !== undefined) doc.deductions = data.deductions;
  if (data.commission !== undefined) doc.commission = data.commission;
  if (data.isActive !== undefined) doc.isActive = data.isActive;
  if (data.extensions !== undefined) doc.extensions = data.extensions;
  if (data.productPackIncentives !== undefined) {
    doc.productPackIncentives = normalizeProductPackIncentives(data.productPackIncentives);
  }

  doc.updatedBy = reqUser.userId;
  await doc.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'salaryStructure.update',
    entityType: 'SalaryStructure',
    entityId: doc._id,
    changes: { before, after: doc.toObject() }
  });

  const [enriched] = await attachAssignedCounts(companyId, [doc]);
  return enriched;
};

module.exports = {
  list,
  getById,
  getStructureForEmployee,
  getActiveForEmployee,
  listAssignedEmployees,
  assignEmployees,
  unassignEmployees,
  create,
  update
};
