const mongoose = require('mongoose');
const Account = require('../models/Account');
const Voucher = require('../models/Voucher');
const FiscalPeriod = require('../models/FiscalPeriod');
const Ledger = require('../models/Ledger');
const SupplierLedger = require('../models/SupplierLedger');
const ApiError = require('../utils/ApiError');
const coaSeed = require('./coaSeed.service');
const glBridge = require('./glBridge.service');
const { ACCOUNT_CODES } = require('../constants/coaTemplate');
const {
  ACCOUNT_GROUP_TYPE,
  VOUCHER_STATUS,
  LEDGER_TYPE,
  LEDGER_ENTITY_TYPE,
  SUPPLIER_LEDGER_TYPE
} = require('../constants/enums');
const { roundPKR } = require('../utils/currency');
const { balanceDelta } = require('./glPosting.service');
const businessTime = require('../utils/businessTime');
const { queryDateBound } = require('../utils/listQuery');

const nd = { isDeleted: { $ne: true } };
const oid = (id) => new mongoose.Types.ObjectId(id);

const parseDateRange = (query, timeZone) => {
  const from = query.from ? queryDateBound(query.from, 'start', timeZone) : null;
  const to = query.to ? queryDateBound(query.to, 'end', timeZone) : null;
  return { from, to };
};

const voucherDateFilter = (from, to) => {
  const f = { status: VOUCHER_STATUS.POSTED, ...nd };
  if (from || to) {
    f.date = {};
    if (from) f.date.$gte = from;
    if (to) f.date.$lte = to;
  }
  return f;
};

/** Trial balance: sum debits/credits per account from posted vouchers in period. */
const trialBalance = async (companyId, query, timeZone = 'UTC') => {
  await coaSeed.ensureCoaForCompany(companyId);
  const { from, to } = parseDateRange(query, timeZone);
  const cid = oid(companyId);

  const accounts = await Account.find({
    companyId: cid,
    isGroup: { $ne: true },
    isActive: true,
    ...nd
  })
    .sort({ code: 1 })
    .lean();

  const match = { companyId: cid, ...voucherDateFilter(from, to) };
  const agg = await Voucher.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    {
      $group: {
        _id: '$lines.accountId',
        debit: { $sum: '$lines.debit' },
        credit: { $sum: '$lines.credit' }
      }
    }
  ]);

  const periodMap = Object.fromEntries(agg.map((r) => [String(r._id), r]));

  let totalDebit = 0;
  let totalCredit = 0;
  const rows = accounts.map((acc) => {
    const p = periodMap[String(acc._id)] || { debit: 0, credit: 0 };
    const opening = roundPKR(acc.openingBalance || 0);
    const periodDebit = roundPKR(p.debit || 0);
    const periodCredit = roundPKR(p.credit || 0);
    const closing = roundPKR(opening + balanceDelta(acc.groupType, periodDebit, periodCredit));
    totalDebit = roundPKR(totalDebit + periodDebit);
    totalCredit = roundPKR(totalCredit + periodCredit);
    return {
      accountId: acc._id,
      code: acc.code,
      name: acc.name,
      groupType: acc.groupType,
      openingBalance: opening,
      periodDebit,
      periodCredit,
      closingBalance: closing
    };
  });

  return {
    generatedAt: businessTime.utcNowIso(),
    from: from?.toISOString() || null,
    to: to?.toISOString() || null,
    rows,
    totals: { periodDebit: totalDebit, periodCredit: totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 }
  };
};

/** Balance at start of range: book opening + all posted activity before `from`. */
const openingBalanceAt = async (companyId, account, beforeDate) => {
  let bal = roundPKR(account.openingBalance || 0);
  if (!beforeDate) return bal;

  const agg = await Voucher.aggregate([
    {
      $match: {
        companyId: oid(companyId),
        status: VOUCHER_STATUS.POSTED,
        isDeleted: { $ne: true },
        date: { $lt: beforeDate },
        'lines.accountId': account._id
      }
    },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': account._id } },
    {
      $group: {
        _id: null,
        debit: { $sum: '$lines.debit' },
        credit: { $sum: '$lines.credit' }
      }
    }
  ]);

  const p = agg[0] || { debit: 0, credit: 0 };
  return roundPKR(bal + balanceDelta(account.groupType, p.debit || 0, p.credit || 0));
};

/** General ledger for one account or all accounts. */
const generalLedger = async (companyId, query, timeZone = 'UTC') => {
  await coaSeed.ensureCoaForCompany(companyId);
  const { from, to } = parseDateRange(query, timeZone);
  const cid = oid(companyId);
  const accountId = query.accountId ? oid(query.accountId) : null;

  const accFilter = { companyId: cid, isGroup: { $ne: true }, ...nd };
  if (accountId) accFilter._id = accountId;
  const accounts = await Account.find(accFilter).sort({ code: 1 }).lean();
  const accountMap = Object.fromEntries(accounts.map((a) => [String(a._id), a]));

  const match = { companyId: cid, ...voucherDateFilter(from, to) };
  if (accountId) match['lines.accountId'] = accountId;

  const vouchers = await Voucher.find(match).sort({ date: 1, createdAt: 1 }).lean();

  const entries = [];
  for (const v of vouchers) {
    for (const line of v.lines) {
      if (accountId && String(line.accountId) !== String(accountId)) continue;
      const acc = accountMap[String(line.accountId)];
      if (!acc) continue;
      entries.push({
        date: v.date,
        voucherNumber: v.voucherNumber,
        voucherType: v.voucherType,
        voucherId: v._id,
        accountId: line.accountId,
        accountCode: line.accountCode,
        accountName: line.accountName,
        narration: v.narration,
        lineDescription: line.description,
        debit: line.debit,
        credit: line.credit
      });
    }
  }

  entries.sort((a, b) => new Date(a.date) - new Date(b.date));

  const byAccount = {};
  for (const acc of accounts) {
    const openingBalance = await openingBalanceAt(companyId, acc, from);
    byAccount[String(acc._id)] = {
      account: acc,
      openingBalance,
      closingBalance: openingBalance,
      entries: [],
      runningBalance: openingBalance
    };
  }
  for (const e of entries) {
    const bucket = byAccount[String(e.accountId)];
    if (!bucket) continue;
    const acc = bucket.account;
    bucket.runningBalance = roundPKR(
      bucket.runningBalance + balanceDelta(acc.groupType, e.debit, e.credit)
    );
    bucket.closingBalance = bucket.runningBalance;
    bucket.entries.push({ ...e, runningBalance: bucket.runningBalance });
  }

  return {
    generatedAt: businessTime.utcNowIso(),
    from: from?.toISOString() || null,
    to: to?.toISOString() || null,
    accounts: Object.values(byAccount)
  };
};

/** P&L from income and expense accounts. */
const profitAndLoss = async (companyId, query, timeZone = 'UTC') => {
  const tb = await trialBalance(companyId, query, timeZone);
  const income = tb.rows.filter((r) => r.groupType === ACCOUNT_GROUP_TYPE.INCOME);
  const expenses = tb.rows.filter((r) => r.groupType === ACCOUNT_GROUP_TYPE.EXPENSE);

  const totalIncome = roundPKR(income.reduce((s, r) => s + Math.abs(r.closingBalance - r.openingBalance), 0));
  const totalExpense = roundPKR(expenses.reduce((s, r) => s + Math.abs(r.closingBalance - r.openingBalance), 0));
  const netProfit = roundPKR(totalIncome - totalExpense);

  return {
    generatedAt: tb.generatedAt,
    from: tb.from,
    to: tb.to,
    income,
    expenses,
    totalIncome,
    totalExpense,
    netProfit
  };
};

/** Balance sheet from asset, liability, equity accounts. */
const balanceSheet = async (companyId, query, timeZone = 'UTC') => {
  const tb = await trialBalance(companyId, query, timeZone);
  const assets = tb.rows.filter((r) => r.groupType === ACCOUNT_GROUP_TYPE.ASSET);
  const liabilities = tb.rows.filter((r) => r.groupType === ACCOUNT_GROUP_TYPE.LIABILITY);
  const equity = tb.rows.filter((r) => r.groupType === ACCOUNT_GROUP_TYPE.EQUITY);

  const totalAssets = roundPKR(assets.reduce((s, r) => s + r.closingBalance, 0));
  const totalLiabilities = roundPKR(liabilities.reduce((s, r) => s + r.closingBalance, 0));
  const totalEquity = roundPKR(equity.reduce((s, r) => s + r.closingBalance, 0));

  return {
    generatedAt: tb.generatedAt,
    asOf: tb.to,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    totalLiabilitiesAndEquity: roundPKR(totalLiabilities + totalEquity),
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 1
  };
};

/** Day book — all voucher lines chronologically. */
const dayBook = async (companyId, query, timeZone = 'UTC') => {
  const gl = await generalLedger(companyId, query, timeZone);
  const flat = [];
  for (const bucket of gl.accounts) {
    flat.push(...bucket.entries);
  }
  flat.sort((a, b) => new Date(a.date) - new Date(b.date) || a.voucherNumber.localeCompare(b.voucherNumber));
  return { generatedAt: gl.generatedAt, from: gl.from, to: gl.to, entries: flat };
};

const cashOrBankBook = async (companyId, query, timeZone, { isCash, isBank }) => {
  await coaSeed.ensureCoaForCompany(companyId);
  const filter = { companyId: oid(companyId), isGroup: { $ne: true }, ...nd };
  if (isCash) filter.isCash = true;
  if (isBank) filter.isBank = true;
  const accounts = await Account.find(filter).lean();
  if (!accounts.length) return { generatedAt: businessTime.utcNowIso(), accounts: [] };

  const combined = { generatedAt: businessTime.utcNowIso(), from: null, to: null, accounts: [] };
  for (const acc of accounts) {
    const gl = await generalLedger(companyId, { ...query, accountId: String(acc._id) }, timeZone);
    combined.from = gl.from;
    combined.to = gl.to;
    combined.accounts.push(...gl.accounts);
  }
  return combined;
};

const cashBook = (companyId, query, timeZone) => cashOrBankBook(companyId, query, timeZone, { isCash: true });
const bankBook = (companyId, query, timeZone) => cashOrBankBook(companyId, query, timeZone, { isBank: true });

/** Sub-ledger vs GL control account reconciliation. */
const subLedgerReconciliation = async (companyId, controlCode) => {
  await coaSeed.ensureCoaForCompany(companyId);
  const code = controlCode || ACCOUNT_CODES.ACCOUNTS_RECEIVABLE;
  const glInfo = await glBridge.reconcileControlAccount(companyId, code);
  if (!glInfo) return null;

  const cid = oid(companyId);
  let subLedgerBalance = 0;

  if (code === ACCOUNT_CODES.ACCOUNTS_RECEIVABLE) {
    const r = await Ledger.aggregate([
      {
        $match: {
          companyId: cid,
          entityType: LEDGER_ENTITY_TYPE.PHARMACY,
          ...nd
        }
      },
      {
        $group: {
          _id: null,
          d: { $sum: { $cond: [{ $eq: ['$type', LEDGER_TYPE.DEBIT] }, '$amount', 0] } },
          c: { $sum: { $cond: [{ $eq: ['$type', LEDGER_TYPE.CREDIT] }, '$amount', 0] } }
        }
      }
    ]);
    subLedgerBalance = roundPKR((r[0]?.d || 0) - (r[0]?.c || 0));
  } else if (code === ACCOUNT_CODES.ACCOUNTS_PAYABLE) {
    const suppliers = await SupplierLedger.find({ companyId: cid, ...nd }).lean();
    for (const row of suppliers) {
      const amt = roundPKR(row.amount || 0);
      if (row.type === SUPPLIER_LEDGER_TYPE.PURCHASE) subLedgerBalance = roundPKR(subLedgerBalance + amt);
      else if (row.type === SUPPLIER_LEDGER_TYPE.PAYMENT || row.type === SUPPLIER_LEDGER_TYPE.PURCHASE_RETURN) {
        subLedgerBalance = roundPKR(subLedgerBalance - amt);
      } else if (row.type === SUPPLIER_LEDGER_TYPE.ADJUSTMENT) {
        subLedgerBalance =
          row.adjustmentEffect === 'INCREASE_PAYABLE'
            ? roundPKR(subLedgerBalance + amt)
            : roundPKR(subLedgerBalance - amt);
      }
    }
  }

  return {
    controlAccount: glInfo,
    subLedgerBalance,
    glBalance: glInfo.glBalance,
    difference: roundPKR(subLedgerBalance - glInfo.glBalance)
  };
};

const closeFiscalPeriod = async (companyId, periodId, reqUser) => {
  const period = await FiscalPeriod.findOne({ _id: oid(periodId), companyId: oid(companyId), ...nd });
  if (!period) throw new ApiError(404, 'Fiscal period not found');
  if (period.isClosed) throw new ApiError(400, 'Period already closed');
  period.isClosed = true;
  period.closedAt = new Date();
  period.closedBy = reqUser.userId;
  await period.save();
  return period;
};

const listFiscalPeriods = async (companyId) => {
  await coaSeed.ensureCoaForCompany(companyId);
  return FiscalPeriod.find({ companyId: oid(companyId), ...nd }).sort({ startDate: -1 }).lean();
};

module.exports = {
  trialBalance,
  generalLedger,
  profitAndLoss,
  balanceSheet,
  dayBook,
  cashBook,
  bankBook,
  subLedgerReconciliation,
  closeFiscalPeriod,
  listFiscalPeriods
};
