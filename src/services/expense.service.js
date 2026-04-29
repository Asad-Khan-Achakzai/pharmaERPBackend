const Expense = require('../models/Expense');
const Transaction = require('../models/Transaction');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { TRANSACTION_TYPE } = require('../constants/enums');
const { roundPKR } = require('../utils/currency');
const auditService = require('./audit.service');
const {
  escapeRegex,
  qScalar,
  applyDateFieldRangeFromQuery,
  applyCreatedByFromQuery
} = require('../utils/listQuery');

const list = async (companyId, query) => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.category) filter.category = query.category;
  applyDateFieldRangeFromQuery(filter, query, 'date');
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { description: { $regex: rx, $options: 'i' } },
      { category: { $regex: rx, $options: 'i' } }
    ];
  }
  applyCreatedByFromQuery(filter, query);
  const [docs, total] = await Promise.all([
    Expense.find(filter)
      .populate('distributorId', 'name')
      .populate('doctorId', 'name')
      .populate('employeeId', 'name')
      .populate('approvedBy', 'name')
      .sort(sort).skip(skip).limit(limit),
    Expense.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const expense = await Expense.create({ ...data, companyId, approvedBy: reqUser.userId, createdBy: reqUser.userId });

  await Transaction.create({
    companyId,
    type: TRANSACTION_TYPE.EXPENSE,
    referenceType: 'EXPENSE',
    referenceId: expense._id,
    revenue: 0,
    cost: data.amount,
    profit: roundPKR(-data.amount),
    date: data.date || new Date(),
    description: `Expense: ${data.category} - ${data.description || ''}`
  });

  await auditService.log({ companyId, userId: reqUser.userId, action: 'expense.create', entityType: 'Expense', entityId: expense._id, changes: { after: expense.toObject() } });
  return expense;
};

const update = async (companyId, id, data, reqUser) => {
  const expense = await Expense.findOne({ _id: id, companyId });
  if (!expense) throw new ApiError(404, 'Expense not found');
  const before = expense.toObject();

  const oldAmount = expense.amount;
  Object.assign(expense, { ...data, updatedBy: reqUser.userId });
  await expense.save();

  if (data.amount !== undefined && data.amount !== oldAmount) {
    await Transaction.updateOne(
      { companyId, referenceType: 'EXPENSE', referenceId: expense._id },
      { cost: data.amount, profit: roundPKR(-data.amount) }
    );
  }

  await auditService.log({ companyId, userId: reqUser.userId, action: 'expense.update', entityType: 'Expense', entityId: expense._id, changes: { before, after: expense.toObject() } });
  return expense;
};

const remove = async (companyId, id, reqUser) => {
  const expense = await Expense.findOne({ _id: id, companyId });
  if (!expense) throw new ApiError(404, 'Expense not found');
  const before = expense.toObject();
  const transaction = await Transaction.findOne({ companyId, referenceType: 'EXPENSE', referenceId: expense._id });
  if (transaction) await transaction.softDelete(reqUser.userId);
  await expense.softDelete(reqUser.userId);
  await auditService.log({ companyId, userId: reqUser.userId, action: 'expense.delete', entityType: 'Expense', entityId: expense._id, changes: { before } });
};

module.exports = { list, create, update, remove };
