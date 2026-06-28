const mongoose = require('mongoose');
const Account = require('../models/Account');
const Voucher = require('../models/Voucher');
const Collection = require('../models/Collection');
const Expense = require('../models/Expense');
const DoctorActivity = require('../models/DoctorActivity');
const Settlement = require('../models/Settlement');
const SupplierLedger = require('../models/SupplierLedger');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const coaSeed = require('./coaSeed.service');
const moneyAccountService = require('./moneyAccount.service');
const auditService = require('./audit.service');
const { ACCOUNT_GROUP_TYPE } = require('../constants/enums');
const { roundPKR } = require('../utils/currency');
const { escapeRegex, qScalar } = require('../utils/listQuery');

const nd = { isDeleted: { $ne: true } };
const oid = (id) => new mongoose.Types.ObjectId(id);

const list = async (companyId, query = {}) => {
  await coaSeed.ensureCoaForCompany(companyId);
  const { search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId: oid(companyId), ...nd };
  if (query.groupType) filter.groupType = query.groupType;
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true' || query.isActive === true;
  if (query.isGroup !== undefined) filter.isGroup = query.isGroup === 'true' || query.isGroup === true;
  if (query.isCash === 'true') filter.isCash = true;
  if (query.isBank === 'true') filter.isBank = true;
  if (query.isMoneyAccount === 'true') filter.isMoneyAccount = true;
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [{ code: { $regex: rx, $options: 'i' } }, { name: { $regex: rx, $options: 'i' } }];
  }
  const docs = await Account.find(filter).sort({ code: 1 }).lean();
  return docs;
};

const getTree = async (companyId) => {
  const flat = await list(companyId, {});
  const byId = Object.fromEntries(flat.map((a) => [String(a._id), { ...a, children: [] }]));
  const roots = [];
  for (const a of flat) {
    const node = byId[String(a._id)];
    if (a.parentId && byId[String(a.parentId)]) {
      byId[String(a.parentId)].children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
};

const getById = async (companyId, id) => {
  const acc = await Account.findOne({ _id: oid(id), companyId: oid(companyId), ...nd });
  if (!acc) throw new ApiError(404, 'Account not found');
  return acc;
};

const create = async (companyId, data, reqUser) => {
  await coaSeed.ensureCoaForCompany(companyId);
  const code = String(data.code || '').trim();
  if (!code) throw new ApiError(400, 'Account code is required');
  const exists = await Account.findOne({ companyId: oid(companyId), code, ...nd });
  if (exists) throw new ApiError(409, 'Account code already exists');

  let parentId = data.parentId || null;
  if (parentId) {
    const parent = await getById(companyId, parentId);
    if (!parent.isGroup) throw new ApiError(400, 'Parent must be a group account');
    parentId = parent._id;
  }

  const isCash = data.isCash === true;
  const isBank = data.isBank === true;
  const isMoneyAccount = data.isMoneyAccount === true || isCash || isBank;
  let moneyAccountNature = data.moneyAccountNature || null;
  if (!moneyAccountNature && isBank) moneyAccountNature = 'BANK';
  else if (!moneyAccountNature && isCash) moneyAccountNature = 'CASH';

  const acc = await Account.create({
    companyId: oid(companyId),
    code,
    name: String(data.name || '').trim(),
    groupType: data.groupType,
    parentId,
    isGroup: data.isGroup === true,
    isControlAccount: data.isControlAccount === true,
    isCash,
    isBank,
    isMoneyAccount,
    moneyAccountNature,
    linkedEntityType: data.linkedEntityType || null,
    openingBalance: roundPKR(data.openingBalance || 0),
    currentBalance: roundPKR(data.openingBalance || 0),
    isActive: data.isActive !== false,
    isSystem: false,
    description: data.description || null,
    createdBy: reqUser.userId
  });

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'account.create',
    entityType: 'Account',
    entityId: acc._id,
    changes: { after: acc.toObject() }
  });
  return acc;
};

const update = async (companyId, id, data, reqUser) => {
  const acc = await getById(companyId, id);
  const before = acc.toObject();
  if (acc.isSystem) {
    throw new ApiError(400, 'Core system accounts cannot be edited — rename display only via Advanced Accounting');
  }
  if (acc.isControlAccount && data.name !== undefined) {
    throw new ApiError(400, 'Control account names are system-managed');
  }
  if (acc.isGroup) {
    throw new ApiError(400, 'Category folders cannot be edited here');
  }
  if (data.name !== undefined) acc.name = String(data.name).trim();
  if (data.description !== undefined) acc.description = data.description;
  if (data.isActive !== undefined) acc.isActive = data.isActive;
  await acc.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'account.update',
    entityType: 'Account',
    entityId: acc._id,
    changes: { before, after: acc.toObject() }
  });
  return acc;
};

const setOpeningBalance = async (companyId, id, openingBalance, reqUser) => {
  const acc = await getById(companyId, id);
  if (acc.isGroup) throw new ApiError(400, 'Cannot set opening balance on group account');
  const before = acc.toObject();
  const ob = roundPKR(openingBalance);
  const diff = roundPKR(ob - (acc.openingBalance || 0));
  acc.openingBalance = ob;
  acc.currentBalance = roundPKR((acc.currentBalance || 0) + diff);
  await acc.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'account.openingBalance',
    entityType: 'Account',
    entityId: acc._id,
    changes: { before, after: acc.toObject() }
  });
  return acc;
};

/**
 * Returns true if the account is referenced by any financial transaction
 * (vouchers, collections, expenses, doctor activities, settlements, supplier ledgers).
 * Used to prevent deleting accounts that carry history — even when the balance is zero.
 */
const hasTransactionReferences = async (companyId, accountId) => {
  const cid = oid(companyId);
  const aid = oid(accountId);
  const checks = [
    Voucher.exists({
      companyId: cid,
      ...nd,
      $or: [{ 'lines.accountId': aid }, { moneyAccountId: aid }, { toMoneyAccountId: aid }]
    }),
    Collection.exists({ companyId: cid, ...nd, moneyAccountId: aid }),
    Expense.exists({ companyId: cid, ...nd, $or: [{ moneyAccountId: aid }, { expenseAccountId: aid }] }),
    DoctorActivity.exists({ companyId: cid, ...nd, moneyAccountId: aid }),
    Settlement.exists({ companyId: cid, ...nd, moneyAccountId: aid }),
    SupplierLedger.exists({ companyId: cid, ...nd, moneyAccountId: aid })
  ];
  const results = await Promise.all(checks);
  return results.some(Boolean);
};

const remove = async (companyId, id, reqUser) => {
  const acc = await getById(companyId, id);
  if (acc.isSystem) throw new ApiError(400, 'Cannot delete system account');
  if (acc.isControlAccount) throw new ApiError(400, 'Cannot delete a system control account');
  if (acc.isGroup) throw new ApiError(400, 'Cannot delete category folders — use Advanced Accounting mode');
  const child = await Account.findOne({ companyId: oid(companyId), parentId: acc._id, ...nd });
  if (child) throw new ApiError(400, 'Account has child accounts');
  if (await hasTransactionReferences(companyId, acc._id)) {
    throw new ApiError(400, 'This account has transaction history and cannot be deleted. Please deactivate it instead.');
  }
  if (Math.abs(acc.currentBalance || 0) > 0.001) {
    throw new ApiError(400, 'Account has non-zero balance');
  }
  await acc.softDelete(reqUser.userId);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'account.delete',
    entityType: 'Account',
    entityId: acc._id,
    changes: { before: acc.toObject() }
  });
};

const GROUP_TYPES = Object.values(ACCOUNT_GROUP_TYPE);

const listMoneyAccounts = async (companyId, query = {}) =>
  moneyAccountService.listMoneyAccounts(companyId, {
    includeInactive: query.includeInactive === 'true' || query.includeInactive === true
  });

module.exports = { list, getTree, getById, create, update, setOpeningBalance, remove, GROUP_TYPES, listMoneyAccounts };
