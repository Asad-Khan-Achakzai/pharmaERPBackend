const mongoose = require('mongoose');
const Account = require('../models/Account');
const ApiError = require('../utils/ApiError');
const coaSeed = require('./coaSeed.service');
const auditService = require('./audit.service');
const { roundPKR } = require('../utils/currency');
const {
  SIMPLE_ACCOUNT_TYPE,
  SIMPLE_ACCOUNT_TEMPLATES,
  MONEY_SIMPLE_TYPES
} = require('../constants/simpleAccountTypes');

const nd = { isDeleted: { $ne: true } };
const oid = (id) => new mongoose.Types.ObjectId(id);

const getParentByCode = async (companyId, parentCode, session = null) => {
  const parent = await Account.findOne({
    companyId: oid(companyId),
    code: parentCode,
    isGroup: true,
    ...nd
  }).session(session || null);
  if (!parent) throw new ApiError(500, 'Financial structure not initialized — contact support');
  return parent;
};

const nextAvailableCode = async (companyId, { start, end }, session = null) => {
  const existing = await Account.find({
    companyId: oid(companyId),
    ...nd
  })
    .select('code')
    .session(session || null)
    .lean();
  const used = new Set(existing.map((a) => a.code));
  for (let n = start; n <= end; n++) {
    const code = String(n);
    if (!used.has(code)) return code;
  }
  throw new ApiError(400, 'No available account slots — ask your accountant to extend the chart');
};

const assertCanCreateType = (accountType, reqUser) => {
  const perms = reqUser?.permissions || [];
  const has = (p) => perms.includes(p) || perms.includes('admin.access');
  if (has('accounts.manage')) return;
  if (has('payments.create') && MONEY_SIMPLE_TYPES.includes(accountType)) return;
  throw new ApiError(403, 'You do not have permission to create this account type');
};

/**
 * Create a posting account from a business-friendly type — no accounting fields exposed.
 */
const createSimple = async (companyId, body, reqUser) => {
  const accountType = body.accountType;
  const template = SIMPLE_ACCOUNT_TEMPLATES[accountType];
  if (!template) throw new ApiError(400, 'Invalid account type');

  assertCanCreateType(accountType, reqUser);

  const name = String(body.name || '').trim();
  if (!name) throw new ApiError(400, 'Name is required');

  await coaSeed.ensureCoaForCompany(companyId);

  const parent = await getParentByCode(companyId, template.parentCode);
  const code = await nextAvailableCode(companyId, template.codeRange);

  const openingBalance = roundPKR(body.openingBalance || 0);
  const descriptionParts = [];
  if (body.accountNumber) descriptionParts.push(`Account #: ${String(body.accountNumber).trim()}`);
  if (body.notes) descriptionParts.push(String(body.notes).trim());
  const description = descriptionParts.length ? descriptionParts.join('\n') : null;

  const acc = await Account.create({
    companyId: oid(companyId),
    code,
    name,
    groupType: template.groupType,
    parentId: parent._id,
    isGroup: false,
    isControlAccount: false,
    isCash: template.isCash === true,
    isBank: template.isBank === true,
    isMoneyAccount: template.isMoneyAccount === true,
    moneyAccountNature: template.moneyAccountNature || null,
    linkedEntityType: null,
    openingBalance,
    currentBalance: openingBalance,
    isActive: true,
    isSystem: false,
    description,
    createdBy: reqUser.userId
  });

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'account.createSimple',
    entityType: 'Account',
    entityId: acc._id,
    changes: { after: acc.toObject(), accountType }
  });

  return { ...acc.toObject(), accountType };
};

/** Business-friendly grouped catalog — no COA hierarchy exposed. */
const getBusinessView = async (companyId) => {
  await coaSeed.ensureCoaForCompany(companyId);
  const all = await Account.find({
    companyId: oid(companyId),
    isGroup: { $ne: true },
    isActive: true,
    ...nd
  })
    .sort({ code: 1 })
    .lean();

  const moneyAccounts = all.filter((a) => a.isMoneyAccount);
  const expenseCategories = all.filter((a) => a.groupType === 'EXPENSE' && !a.isControlAccount);
  const incomeCategories = all.filter((a) => a.groupType === 'INCOME' && !a.isControlAccount);
  const inventoryAccounts = all.filter(
    (a) => a.groupType === 'ASSET' && !a.isMoneyAccount && !a.isControlAccount && /^11[45]/.test(a.code)
  );

  return {
    moneyAccounts,
    expenseCategories,
    incomeCategories,
    inventoryAccounts,
    notices: {
      suppliers:
        'Supplier balances are tracked automatically in the Suppliers module — use Other Payable only for non-supplier liabilities.',
      pharmacies:
        'Customer/pharmacy balances are tracked automatically — use Other Receivable only for special cases.'
    }
  };
};

const listSimpleTypes = () =>
  Object.entries(SIMPLE_ACCOUNT_TEMPLATES).map(([id, t]) => ({
    id,
    label: t.label
  }));

module.exports = {
  createSimple,
  getBusinessView,
  listSimpleTypes,
  SIMPLE_ACCOUNT_TYPE
};
