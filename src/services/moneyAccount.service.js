const mongoose = require('mongoose');
const Account = require('../models/Account');
const ApiError = require('../utils/ApiError');
const coaSeed = require('./coaSeed.service');
const { MONEY_ACCOUNT_NATURE } = require('../constants/enums');

const nd = { isDeleted: { $ne: true } };
const oid = (id) => new mongoose.Types.ObjectId(id);

const syncMoneyAccountFlags = async (companyId, session = null) => {
  const base = { companyId: oid(companyId), ...nd, isGroup: { $ne: true } };
  await Account.updateMany(
    { ...base, isCash: true },
    { $set: { isMoneyAccount: true, moneyAccountNature: MONEY_ACCOUNT_NATURE.CASH } },
    { session }
  );
  await Account.updateMany(
    { ...base, isBank: true },
    { $set: { isMoneyAccount: true, moneyAccountNature: MONEY_ACCOUNT_NATURE.BANK } },
    { session }
  );
};

const listMoneyAccounts = async (companyId) => {
  await coaSeed.ensureCoaForCompany(companyId);
  await syncMoneyAccountFlags(companyId);
  return Account.find({
    companyId: oid(companyId),
    isMoneyAccount: true,
    isActive: true,
    isGroup: { $ne: true },
    ...nd
  })
    .sort({ code: 1 })
    .lean();
};

/**
 * Validates that accountId is an active money account for the company.
 */
const assertMoneyAccount = async (companyId, accountId, session = null) => {
  if (!accountId) throw new ApiError(400, 'Money account is required');

  // COA seed + flag sync are one-time/setup operations — never run bulk updates inside an active transaction
  if (!session) {
    await coaSeed.ensureCoaForCompany(companyId);
    await syncMoneyAccountFlags(companyId);
  }

  const acc = await Account.findOne({
    companyId: oid(companyId),
    _id: oid(accountId),
    isActive: true,
    isGroup: { $ne: true },
    $or: [{ isMoneyAccount: true }, { isCash: true }, { isBank: true }],
    ...nd
  }).session(session || null);

  if (!acc) {
    throw new ApiError(400, 'Invalid money account — select a Cash or Bank account');
  }
  return acc;
};

module.exports = {
  listMoneyAccounts,
  assertMoneyAccount,
  syncMoneyAccountFlags
};
