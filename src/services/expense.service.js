const mongoose = require('mongoose');
const Expense = require('../models/Expense');
const Company = require('../models/Company');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const Account = require('../models/Account');
const { ACCOUNT_CODES } = require('../constants/coaTemplate');
const { TRANSACTION_TYPE, EXPENSE_STATUS, EXPENSE_CATEGORY } = require('../constants/enums');
const coaSeed = require('./coaSeed.service');
const { roundPKR } = require('../utils/currency');
const auditService = require('./audit.service');
const moneyAccountService = require('./moneyAccount.service');
const notificationService = require('./notification.service');
const { NOTIFICATION_KIND } = require('../constants/enums');
const { userHasTenantWideAccess } = require('../utils/effectivePermissions');
const { resolveSubtreeUserIds } = require('../utils/teamScope');
const {
  escapeRegex,
  qScalar,
  applyDateFieldRangeFromQuery,
  applyCreatedByFromQuery
} = require('../utils/listQuery');

const nd = { isDeleted: { $ne: true } };
const oid = (id) => new mongoose.Types.ObjectId(id);

const expenseCategoryToAccountCode = (category) => {
  switch (category) {
    case EXPENSE_CATEGORY.SALARY:
      return ACCOUNT_CODES.SALARY_EXPENSE;
    case EXPENSE_CATEGORY.RENT:
      return ACCOUNT_CODES.RENT_EXPENSE;
    case EXPENSE_CATEGORY.LOGISTICS:
      return ACCOUNT_CODES.LOGISTICS_EXPENSE;
    case EXPENSE_CATEGORY.OFFICE:
    case EXPENSE_CATEGORY.OTHER:
    default:
      return ACCOUNT_CODES.OPERATING_EXPENSE;
  }
};

const resolveAccountIdByCode = async (companyId, code, session = null) => {
  await coaSeed.ensureCoaForCompany(companyId, session ? { session } : {});
  const acc = await Account.findOne({
    companyId: oid(companyId),
    code,
    isActive: true,
    isGroup: { $ne: true },
    ...nd
  }).session(session || null);
  if (!acc) throw new ApiError(400, `Account ${code} is not configured for this company`);
  return acc._id;
};

/** Web sends COA ids; mobile sends category — normalize before posting. */
const resolveCreatePayload = async (companyId, data, session = null) => {
  const payload = { ...data };
  if (!payload.expenseAccountId) {
    if (!payload.category) throw new ApiError(400, 'expenseAccountId or category is required');
    const code = expenseCategoryToAccountCode(payload.category);
    payload.expenseAccountId = await resolveAccountIdByCode(companyId, code, session);
  }
  if (!payload.moneyAccountId) {
    payload.moneyAccountId = await resolveAccountIdByCode(companyId, ACCOUNT_CODES.CASH, session);
  }
  return payload;
};

const populateOpts = [
  { path: 'expenseAccountId', select: 'code name' },
  { path: 'moneyAccountId', select: 'code name moneyAccountNature' },
  { path: 'voucherId', select: 'voucherNumber voucherType' },
  { path: 'employeeId', select: 'name' },
  { path: 'approvedBy', select: 'name' },
  { path: 'createdBy', select: 'name' }
];

const assertExpenseAccount = async (companyId, accountId, session = null) => {
  const coaSeed = require('./coaSeed.service');
  const Account = require('../models/Account');
  const { ACCOUNT_GROUP_TYPE } = require('../constants/enums');
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

async function isExpenseApprovalRequired(companyId) {
  const company = await Company.findById(companyId).select('expenseApprovalRequired').lean();
  return !!company?.expenseApprovalRequired;
}

async function postExpenseLedger(session, companyId, expense, expAcc, moneyAcc, amount, expenseDate, narration, reqUser) {
  const glBridge = require('./glBridge.service');
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
  return voucher;
}

const list = async (companyId, query, timeZone = 'UTC') => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId, ...nd };
  if (query.expenseAccountId) filter.expenseAccountId = oid(query.expenseAccountId);
  if (query.status) filter.status = query.status;
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

const create = async (companyId, data, reqUser) => {
  const approvalRequired = await isExpenseApprovalRequired(companyId);
  const session = await mongoose.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      const resolved = await resolveCreatePayload(companyId, data, session);
      const expAcc = await assertExpenseAccount(companyId, resolved.expenseAccountId, session);
      const moneyAcc = await moneyAccountService.assertMoneyAccount(companyId, resolved.moneyAccountId, session);
      const amount = roundPKR(resolved.amount);
      const expenseDate = resolved.date ? new Date(resolved.date) : new Date();
      const narration = resolved.description?.trim() || `Expense: ${expAcc.name}`;

      const status = approvalRequired ? EXPENSE_STATUS.PENDING : EXPENSE_STATUS.APPROVED;

      const [expense] = await Expense.create(
        [
          {
            companyId,
            category: resolved.category || null,
            expenseAccountId: expAcc._id,
            moneyAccountId: moneyAcc._id,
            amount,
            description: resolved.description || '',
            date: expenseDate,
            distributorId: resolved.distributorId || undefined,
            doctorId: resolved.doctorId || undefined,
            employeeId: resolved.employeeId || reqUser.userId,
            approvedBy: approvalRequired ? undefined : reqUser.userId,
            status,
            createdBy: reqUser.userId
          }
        ],
        { session }
      );

      if (!approvalRequired) {
        await postExpenseLedger(session, companyId, expense, expAcc, moneyAcc, amount, expenseDate, narration, reqUser);
      }

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

  if (created.status === EXPENSE_STATUS.PENDING) {
    void notifyExpenseManagers(companyId, created, reqUser);
  }

  return Expense.findById(created._id).populate(populateOpts);
};

async function notifyExpenseManagers(companyId, expense, submitter) {
  const targets = new Set();
  let uid = submitter.userId;
  for (let depth = 0; depth < 6; depth += 1) {
    const u = await User.findById(uid).select('managerId').lean();
    if (!u?.managerId) break;
    targets.add(String(u.managerId));
    uid = u.managerId;
  }

  const title = 'Expense pending approval';
  const body = `${expense.description || 'Field expense'} — Rs ${expense.amount}`;
  await Promise.all(
    [...targets].map((userId) =>
      notificationService
        .createForUser({
          companyId,
          userId,
          title,
          body,
          kind: NOTIFICATION_KIND.EXPENSE,
          link: '/(manager)/approvals',
          meta: { expenseId: String(expense._id) }
        })
        .catch(() => null)
    )
  );
}

const inbox = async (companyId, reqUser, query = {}) => {
  const isAdmin = userHasTenantWideAccess(reqUser);
  let employeeIds;
  if (isAdmin) {
    employeeIds = null;
  } else {
    employeeIds = await resolveSubtreeUserIds(companyId, reqUser.userId, {
      includeSelf: false,
      activeOnly: true
    });
    if (!employeeIds.length) return { docs: [], total: 0, page: 1, limit: query.limit || 20 };
  }

  const filter = { companyId, status: EXPENSE_STATUS.PENDING, ...nd };
  if (employeeIds) filter.employeeId = { $in: employeeIds };

  const { page, limit, skip } = parsePagination(query);
  const [docs, total] = await Promise.all([
    Expense.find(filter).populate(populateOpts).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Expense.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const approve = async (companyId, id, data, reqUser) => {
  const expense = await Expense.findOne({ _id: id, companyId, ...nd });
  if (!expense) throw new ApiError(404, 'Expense not found');
  if (expense.status !== EXPENSE_STATUS.PENDING) throw new ApiError(400, 'Expense is not pending approval');
  if (expense.voucherId) throw new ApiError(400, 'Expense already posted');
  if (!data?.moneyAccountId) throw new ApiError(400, 'Paid-from money account is required');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const expAcc = await assertExpenseAccount(companyId, expense.expenseAccountId, session);
      const moneyAcc = await moneyAccountService.assertMoneyAccount(companyId, data.moneyAccountId, session);
      const amount = roundPKR(expense.amount);
      const expenseDate = expense.date || new Date();
      const narration = expense.description?.trim() || `Expense: ${expAcc.name}`;

      expense.status = EXPENSE_STATUS.APPROVED;
      expense.approvedBy = reqUser.userId;
      expense.moneyAccountId = moneyAcc._id;
      await expense.save({ session });
      await postExpenseLedger(session, companyId, expense, expAcc, moneyAcc, amount, expenseDate, narration, reqUser);
    });
  } finally {
    await session.endSession();
  }

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'expense.approve',
    entityType: 'Expense',
    entityId: expense._id,
    changes: { after: { status: EXPENSE_STATUS.APPROVED, moneyAccountId: expense.moneyAccountId } }
  });

  if (expense.employeeId) {
    void notificationService.createForUser({
      companyId,
      userId: expense.employeeId,
      title: 'Expense approved',
      body: expense.description || 'Your expense was approved',
      kind: NOTIFICATION_KIND.EXPENSE,
      link: '/expenses'
    });
  }

  return Expense.findById(expense._id).populate(populateOpts);
};

const reject = async (companyId, id, reason, reqUser) => {
  const expense = await Expense.findOne({ _id: id, companyId, ...nd });
  if (!expense) throw new ApiError(404, 'Expense not found');
  if (expense.status !== EXPENSE_STATUS.PENDING) throw new ApiError(400, 'Expense is not pending approval');

  expense.status = EXPENSE_STATUS.REJECTED;
  expense.rejectionReason = reason;
  expense.approvedBy = reqUser.userId;
  await expense.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'expense.reject',
    entityType: 'Expense',
    entityId: expense._id,
    changes: { after: { status: EXPENSE_STATUS.REJECTED, reason } }
  });

  if (expense.employeeId) {
    void notificationService.createForUser({
      companyId,
      userId: expense.employeeId,
      title: 'Expense rejected',
      body: reason,
      kind: NOTIFICATION_KIND.EXPENSE,
      link: '/expenses'
    });
  }

  return Expense.findById(expense._id).populate(populateOpts);
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
  if (expense.voucherId && expense.status === EXPENSE_STATUS.APPROVED) {
    throw new ApiError(400, 'Posted expenses cannot be deleted — reverse the voucher first');
  }
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

module.exports = {
  list,
  create,
  update,
  remove,
  inbox,
  approve,
  reject,
  assertExpenseAccount
};
