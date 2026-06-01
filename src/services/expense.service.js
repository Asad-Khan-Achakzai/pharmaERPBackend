const mongoose = require('mongoose');
const Expense = require('../models/Expense');
const Account = require('../models/Account');
const Transaction = require('../models/Transaction');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { TRANSACTION_TYPE, ACCOUNT_GROUP_TYPE } = require('../constants/enums');
const { roundPKR } = require('../utils/currency');
const auditService = require('./audit.service');
const glBridge = require('./glBridge.service');
const moneyAccountService = require('./moneyAccount.service');
const coaSeed = require('./coaSeed.service');
const {
  escapeRegex,
  qScalar,
  applyDateFieldRangeFromQuery,
  applyCreatedByFromQuery
} = require('../utils/listQuery');

const nd = { isDeleted: { $ne: true } };
const oid = (id) => new mongoose.Types.ObjectId(id);

const populateOpts = [
  { path: 'expenseAccountId', select: 'code name' },
  { path: 'moneyAccountId', select: 'code name moneyAccountNature' },
  { path: 'voucherId', select: 'voucherNumber voucherType' },
  { path: 'employeeId', select: 'name' },
  { path: 'approvedBy', select: 'name' }
];

const assertExpenseAccount = async (companyId, accountId, session = null) => {
  await coaSeed.ensureCoaForCompany(companyId, session ? { session } : {});
  const acc = await Account.findOne({
    companyId: oid(companyId),
    _id: oid(accountId),
    groupType: ACCOUNT_GROUP_TYPE.EXPENSE,
    isGroup: { $ne: true },
    isControlAccount: { $ne: true },
    isActive: true,
    ...nd
  }).session(session || null);
  if (!acc) throw new ApiError(400, 'Select a valid expense account from Chart of Accounts');
  return acc;
};

const list = async (companyId, query, timeZone = 'UTC') => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId, ...nd };
  if (query.expenseAccountId) filter.expenseAccountId = oid(query.expenseAccountId);
  applyDateFieldRangeFromQuery(filter, query, 'date', timeZone);
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [{ description: { $regex: rx, $options: 'i' } }];
  }
  applyCreatedByFromQuery(filter, query);
  const [docs, total] = await Promise.all([
    Expense.find(filter).populate(populateOpts).sort(sort).skip(skip).limit(limit),
    Expense.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

/**
 * Create expense with mandatory PV: Dr expense account, Cr money account.
 */
const create = async (companyId, data, reqUser) => {
  const session = await mongoose.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      const expAcc = await assertExpenseAccount(companyId, data.expenseAccountId, session);
      const moneyAcc = await moneyAccountService.assertMoneyAccount(companyId, data.moneyAccountId, session);
      const amount = roundPKR(data.amount);
      const expenseDate = data.date ? new Date(data.date) : new Date();
      const narration = data.description?.trim() || `Expense: ${expAcc.name}`;

      const [expense] = await Expense.create(
        [
          {
            companyId,
            expenseAccountId: expAcc._id,
            moneyAccountId: moneyAcc._id,
            amount,
            description: data.description || '',
            date: expenseDate,
            distributorId: data.distributorId || undefined,
            doctorId: data.doctorId || undefined,
            employeeId: data.employeeId || undefined,
            approvedBy: reqUser.userId,
            createdBy: reqUser.userId
          }
        ],
        { session }
      );

      const voucher = await glBridge.postExpenseGl(
        session,
        companyId,
        {
          expenseId: expense._id,
          expenseAccountId: expAcc._id,
          moneyAccountId: moneyAcc._id,
          amount,
          date: expenseDate,
          narration
        },
        reqUser
      );

      if (!voucher) throw new ApiError(500, 'Failed to post expense voucher');

      expense.voucherId = voucher._id;
      await expense.save({ session });

      await Transaction.create(
        [
          {
            companyId,
            type: TRANSACTION_TYPE.EXPENSE,
            referenceType: 'EXPENSE',
            referenceId: expense._id,
            revenue: 0,
            cost: amount,
            profit: roundPKR(-amount),
            date: expenseDate,
            description: narration,
            createdBy: reqUser.userId
          }
        ],
        { session }
      );

      created = expense;
    });
  } finally {
    await session.endSession();
  }

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'expense.create',
    entityType: 'Expense',
    entityId: created._id,
    changes: { after: created.toObject() }
  });

  return Expense.findById(created._id).populate(populateOpts);
};

const update = async (companyId, id, data, reqUser) => {
  const expense = await Expense.findOne({ _id: id, companyId, ...nd });
  if (!expense) throw new ApiError(404, 'Expense not found');
  if (data.amount !== undefined || data.expenseAccountId || data.moneyAccountId) {
    throw new ApiError(400, 'Amount and accounts cannot be changed after posting — reverse the voucher and create a new expense');
  }
  const before = expense.toObject();
  Object.assign(expense, { ...data, updatedBy: reqUser.userId });
  await expense.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'expense.update',
    entityType: 'Expense',
    entityId: expense._id,
    changes: { before, after: expense.toObject() }
  });
  return expense.populate(populateOpts);
};

const remove = async (companyId, id, reqUser) => {
  const expense = await Expense.findOne({ _id: id, companyId, ...nd });
  if (!expense) throw new ApiError(404, 'Expense not found');
  const before = expense.toObject();
  const transaction = await Transaction.findOne({ companyId, referenceType: 'EXPENSE', referenceId: expense._id, ...nd });
  if (transaction) await transaction.softDelete(reqUser.userId);
  await expense.softDelete(reqUser.userId);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'expense.delete',
    entityType: 'Expense',
    entityId: expense._id,
    changes: { before }
  });
};

module.exports = { list, create, update, remove, assertExpenseAccount };
