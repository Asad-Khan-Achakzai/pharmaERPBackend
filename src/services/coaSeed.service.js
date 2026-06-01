const mongoose = require('mongoose');
const Account = require('../models/Account');
const FiscalPeriod = require('../models/FiscalPeriod');
const VoucherSequence = require('../models/VoucherSequence');
const { DEFAULT_COA } = require('../constants/coaTemplate');
const { VOUCHER_TYPE } = require('../constants/enums');

const VOUCHER_PREFIX = {
  [VOUCHER_TYPE.JV]: 'JV',
  [VOUCHER_TYPE.PV]: 'PV',
  [VOUCHER_TYPE.RV]: 'RV',
  [VOUCHER_TYPE.CV]: 'CV',
  [VOUCHER_TYPE.SV]: 'SV',
  [VOUCHER_TYPE.PURV]: 'PURV',
  [VOUCHER_TYPE.AUTO]: 'AUTO'
};

const normalBalanceForGroup = (groupType) => {
  if (groupType === 'ASSET' || groupType === 'EXPENSE') return ACCOUNT_NORMAL_BALANCE.DEBIT;
  return ACCOUNT_NORMAL_BALANCE.CREDIT;
};

/**
 * Seed default COA, voucher sequences, and current fiscal year for a company.
 * Idempotent — skips if accounts already exist.
 */
const seedCoaForCompany = async (companyId, { createdBy = null, session = null } = {}) => {
  const cid = companyId instanceof mongoose.Types.ObjectId ? companyId : new mongoose.Types.ObjectId(String(companyId));
  const opts = session ? { session } : {};

  const existing = await Account.countDocuments({ companyId: cid, isDeleted: { $ne: true } }).session(session || null);
  if (existing > 0) return { seeded: false, reason: 'accounts_exist' };

  const codeToId = {};
  const toCreate = [];

  for (const row of DEFAULT_COA) {
    toCreate.push({
      companyId: cid,
      code: row.code,
      name: row.name,
      groupType: row.groupType,
      parentId: null,
      isGroup: row.isGroup === true,
      isControlAccount: row.isControlAccount === true,
      isCash: row.isCash === true,
      isBank: row.isBank === true,
      isMoneyAccount: row.isMoneyAccount === true || row.isCash === true || row.isBank === true,
      moneyAccountNature:
        row.moneyAccountNature || (row.isBank ? 'BANK' : row.isCash ? 'CASH' : null),
      linkedEntityType: row.linkedEntityType || null,
      openingBalance: 0,
      currentBalance: 0,
      isActive: true,
      isSystem: true,
      createdBy
    });
  }

  const created = await Account.insertMany(toCreate, { ...opts, ordered: true });

  for (let i = 0; i < DEFAULT_COA.length; i++) {
    codeToId[DEFAULT_COA[i].code] = created[i]._id;
  }

  for (let i = 0; i < DEFAULT_COA.length; i++) {
    const parentCode = DEFAULT_COA[i].parentCode;
    if (parentCode && codeToId[parentCode]) {
      await Account.updateOne({ _id: created[i]._id }, { $set: { parentId: codeToId[parentCode] } }, opts);
    }
  }

  const seqRows = Object.values(VOUCHER_TYPE).map((vt) => ({
    companyId: cid,
    voucherType: vt,
    prefix: VOUCHER_PREFIX[vt] || vt,
    nextNumber: 1
  }));
  await VoucherSequence.insertMany(seqRows, { ...opts, ordered: true });

  const now = new Date();
  const year = now.getFullYear();
  await FiscalPeriod.create(
    [
      {
        companyId: cid,
        name: `FY ${year}`,
        startDate: new Date(year, 0, 1),
        endDate: new Date(year, 11, 31, 23, 59, 59, 999),
        isClosed: false
      }
    ],
    opts
  );

  return { seeded: true, accountCount: created.length, codeToId };
};

const ensureCoaForCompany = async (companyId, opts = {}) => {
  const result = await seedCoaForCompany(companyId, opts);
  // Bulk flag sync must not run inside MongoDB transactions (aborts txn on updateMany)
  if (!opts.session) {
    const moneyAccountService = require('./moneyAccount.service');
    await moneyAccountService.syncMoneyAccountFlags(companyId);
  }
  return result;
};

module.exports = { seedCoaForCompany, ensureCoaForCompany, normalBalanceForGroup, VOUCHER_PREFIX };
