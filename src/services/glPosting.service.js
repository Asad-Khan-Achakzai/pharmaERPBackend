const mongoose = require('mongoose');
const Account = require('../models/Account');
const Voucher = require('../models/Voucher');
const VoucherSequence = require('../models/VoucherSequence');
const FiscalPeriod = require('../models/FiscalPeriod');
const ApiError = require('../utils/ApiError');
const { roundPKR } = require('../utils/currency');
const { VOUCHER_STATUS, ACCOUNT_GROUP_TYPE } = require('../constants/enums');
const { normalBalanceForGroup, VOUCHER_PREFIX } = require('./coaSeed.service');

const oid = (id) => new mongoose.Types.ObjectId(id);
const nd = { isDeleted: { $ne: true } };

const BALANCE_INCREASE = {
  [ACCOUNT_GROUP_TYPE.ASSET]: { debit: 1, credit: -1 },
  [ACCOUNT_GROUP_TYPE.EXPENSE]: { debit: 1, credit: -1 },
  [ACCOUNT_GROUP_TYPE.LIABILITY]: { debit: -1, credit: 1 },
  [ACCOUNT_GROUP_TYPE.EQUITY]: { debit: -1, credit: 1 },
  [ACCOUNT_GROUP_TYPE.INCOME]: { debit: -1, credit: 1 }
};

const balanceDelta = (groupType, debit, credit) => {
  const rule = BALANCE_INCREASE[groupType] || BALANCE_INCREASE[ACCOUNT_GROUP_TYPE.ASSET];
  return roundPKR(debit * rule.debit + credit * rule.credit);
};

const validateLines = (lines) => {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new ApiError(400, 'Voucher requires at least two lines');
  }
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    const d = roundPKR(line.debit || 0);
    const c = roundPKR(line.credit || 0);
    if (d < 0 || c < 0) throw new ApiError(400, 'Debit and credit must be non-negative');
    if (d > 0 && c > 0) throw new ApiError(400, 'A line cannot have both debit and credit');
    if (d === 0 && c === 0) throw new ApiError(400, 'Each line must have debit or credit');
    totalDebit = roundPKR(totalDebit + d);
    totalCredit = roundPKR(totalCredit + c);
  }
  if (Math.abs(totalDebit - totalCredit) > 0.001) {
    throw new ApiError(400, `Voucher is not balanced: debit ${totalDebit} ≠ credit ${totalCredit}`);
  }
  return { totalDebit, totalCredit };
};

const nextVoucherNumber = async (companyId, voucherType, session) => {
  const seq = await VoucherSequence.findOneAndUpdate(
    { companyId: oid(companyId), voucherType },
    { $inc: { nextNumber: 1 } },
    { new: false, upsert: true, session, setDefaultsOnInsert: true }
  );
  const num = seq?.nextNumber ?? 1;
  const prefix = seq?.prefix || VOUCHER_PREFIX[voucherType] || voucherType;
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(num).padStart(5, '0')}`;
};

const resolveFiscalPeriod = async (companyId, date, session) => {
  const d = date instanceof Date ? date : new Date(date);
  return FiscalPeriod.findOne({
    companyId: oid(companyId),
    startDate: { $lte: d },
    endDate: { $gte: d },
    isClosed: { $ne: true },
    ...nd
  })
    .session(session || null)
    .sort({ startDate: -1 });
};

const enrichLinesWithAccounts = async (companyId, lines, session) => {
  const accountIds = [...new Set(lines.map((l) => String(l.accountId)))];
  const accounts = await Account.find({
    companyId: oid(companyId),
    _id: { $in: accountIds.map(oid) },
    isActive: true,
    isGroup: { $ne: true },
    ...nd
  }).session(session || null);
  const map = Object.fromEntries(accounts.map((a) => [String(a._id), a]));
  return lines.map((line, idx) => {
    const acc = map[String(line.accountId)];
    if (!acc) throw new ApiError(400, `Account not found or is a group: ${line.accountId}`);
    return {
      accountId: acc._id,
      accountCode: acc.code,
      accountName: acc.name,
      debit: roundPKR(line.debit || 0),
      credit: roundPKR(line.credit || 0),
      partyEntityType: line.partyEntityType || acc.linkedEntityType || null,
      partyEntityId: line.partyEntityId ? oid(line.partyEntityId) : acc.linkedEntityId || null,
      description: line.description || null,
      lineOrder: line.lineOrder ?? idx
    };
  });
};

/**
 * Post a balanced voucher atomically. Updates account currentBalance.
 */
const postVoucher = async (
  companyId,
  {
    voucherType,
    date,
    narration,
    lines,
    sourceModule = null,
    sourceRefId = null,
    paymentMethod = null,
    moneyAccountId = null,
    toMoneyAccountId = null,
    moneyAccountNature = null,
    status = VOUCHER_STATUS.POSTED,
    voucherNumber: presetNumber = null
  },
  reqUser,
  session
) => {
  const enriched = await enrichLinesWithAccounts(companyId, lines, session);
  const { totalDebit, totalCredit } = validateLines(enriched);

  const duplicate = sourceModule && sourceRefId
    ? await Voucher.findOne({
        companyId: oid(companyId),
        sourceModule,
        sourceRefId: oid(sourceRefId),
        status: VOUCHER_STATUS.POSTED,
        reversalOfVoucherId: null,
        ...nd
      }).session(session || null)
    : null;
  if (duplicate) return duplicate;

  const voucherNumber = presetNumber || (await nextVoucherNumber(companyId, voucherType, session));

  const fiscalPeriod = await resolveFiscalPeriod(companyId, date, session);
  const now = new Date();
  const d = date ? new Date(date) : now;

  const [voucher] = await Voucher.create(
    [
      {
        companyId: oid(companyId),
        voucherNumber,
        voucherType,
        status,
        date: d,
        narration: narration || null,
        lines: enriched,
        totalDebit,
        totalCredit,
        sourceModule,
        sourceRefId: sourceRefId ? oid(sourceRefId) : null,
        fiscalPeriodId: fiscalPeriod?._id || null,
        paymentMethod: paymentMethod || null,
        moneyAccountId: moneyAccountId ? oid(moneyAccountId) : null,
        toMoneyAccountId: toMoneyAccountId ? oid(toMoneyAccountId) : null,
        moneyAccountNature: moneyAccountNature || null,
        postedBy: reqUser?.userId || null,
        postedAt: status === VOUCHER_STATUS.POSTED ? now : null,
        createdBy: reqUser?.userId || null
      }
    ],
    { session, ordered: true }
  );

  if (status === VOUCHER_STATUS.POSTED) {
    for (const line of enriched) {
      const acc = await Account.findById(line.accountId).session(session);
      if (!acc) continue;
      const delta = balanceDelta(acc.groupType, line.debit, line.credit);
      acc.currentBalance = roundPKR((acc.currentBalance || 0) + delta);
      await acc.save({ session });
    }
  }

  return voucher;
};

const reverseVoucher = async (companyId, voucherId, reqUser, session) => {
  const original = await Voucher.findOne({
    companyId: oid(companyId),
    _id: oid(voucherId),
    status: VOUCHER_STATUS.POSTED,
    ...nd
  }).session(session || null);
  if (!original) throw new ApiError(404, 'Posted voucher not found');
  if (original.reversedVoucherId) throw new ApiError(400, 'Voucher already reversed');

  const reversalLines = original.lines.map((line, idx) => ({
    accountId: line.accountId,
    debit: line.credit,
    credit: line.debit,
    partyEntityType: line.partyEntityType,
    partyEntityId: line.partyEntityId,
    description: `Reversal: ${line.description || ''}`.trim(),
    lineOrder: idx
  }));

  const reversal = await postVoucher(
    companyId,
    {
      voucherType: original.voucherType,
      date: new Date(),
      narration: `Reversal of ${original.voucherNumber}`,
      lines: reversalLines,
      sourceModule: original.sourceModule,
      sourceRefId: original.sourceRefId,
      status: VOUCHER_STATUS.POSTED
    },
    reqUser,
    session
  );

  reversal.reversalOfVoucherId = original._id;
  await reversal.save({ session });

  original.status = VOUCHER_STATUS.REVERSED;
  original.reversedVoucherId = reversal._id;
  await original.save({ session });

  return { original, reversal };
};

const getAccountByCode = async (companyId, code, session = null) => {
  return Account.findOne({
    companyId: oid(companyId),
    code: String(code).trim(),
    isActive: true,
    isGroup: { $ne: true },
    ...nd
  }).session(session || null);
};

module.exports = {
  postVoucher,
  reverseVoucher,
  validateLines,
  nextVoucherNumber,
  getAccountByCode,
  balanceDelta,
  enrichLinesWithAccounts,
  resolveFiscalPeriod
};
