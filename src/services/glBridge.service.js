const mongoose = require('mongoose');
const SubLedgerLink = require('../models/SubLedgerLink');
const Account = require('../models/Account');
const glPosting = require('./glPosting.service');
const coaSeed = require('./coaSeed.service');
const moneyAccountService = require('./moneyAccount.service');
const { ACCOUNT_CODES } = require('../constants/coaTemplate');
const {
  VOUCHER_TYPE,
  GL_SOURCE_MODULE,
  SUB_LEDGER_SOURCE,
  EXPENSE_CATEGORY,
  SUPPLIER_PAYMENT_METHOD,
  PAYMENT_METHOD
} = require('../constants/enums');
const { roundPKR } = require('../utils/currency');
const logger = require('../utils/logger');

const oid = (id) => new mongoose.Types.ObjectId(id);

const expenseCategoryToCode = (category) => {
  switch (category) {
    case EXPENSE_CATEGORY.SALARY:
      return ACCOUNT_CODES.SALARY_EXPENSE;
    case EXPENSE_CATEGORY.RENT:
      return ACCOUNT_CODES.RENT_EXPENSE;
    case EXPENSE_CATEGORY.LOGISTICS:
      return ACCOUNT_CODES.LOGISTICS_EXPENSE;
    default:
      return ACCOUNT_CODES.OPERATING_EXPENSE;
  }
};

const paymentMethodToCashOrBank = (method) => {
  const bankMethods = [PAYMENT_METHOD.BANK_TRANSFER, PAYMENT_METHOD.CHEQUE, SUPPLIER_PAYMENT_METHOD.BANK, SUPPLIER_PAYMENT_METHOD.CHEQUE];
  return bankMethods.includes(method) ? ACCOUNT_CODES.BANK : ACCOUNT_CODES.CASH;
};

const ensureCoa = async (companyId, session) => {
  await coaSeed.ensureCoaForCompany(companyId, { session });
};

const linkSubLedger = async (companyId, source, entryId, voucher, lineIndex, session) => {
  const line = voucher.lines[lineIndex];
  if (!line?._id) return;
  await SubLedgerLink.create(
    [
      {
        companyId: oid(companyId),
        subLedgerSource: source,
        subLedgerEntryId: oid(entryId),
        voucherId: voucher._id,
        voucherLineId: line._id
      }
    ],
    { session, ordered: true }
  );
};

const line = (accountId, debit, credit, extra = {}) => ({
  accountId,
  debit: roundPKR(debit || 0),
  credit: roundPKR(credit || 0),
  ...extra
});

/**
 * Sales delivery: Dr AR / Cr Sales (+ tax liability credits) (+ optional COGS/Inventory).
 * When tax is present: AR = invoiceGrandTotal, Sales = goodsNet, Tax Payable = taxTotal.
 */
const postDeliveryGl = async (session, companyId, ctx, reqUser) => {
  try {
    await ensureCoa(companyId, session);
    const ar = await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, session);
    const sales = await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.SALES_REVENUE, session);
    const cogs = await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.COGS, session);
    const inv = await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.INVENTORY, session);
    if (!ar || !sales) return null;

    const goods = roundPKR(ctx.goodsNetPayable ?? ctx.pharmacyNetPayable ?? 0);
    const grand = roundPKR(ctx.invoiceGrandTotal ?? ctx.pharmacyNetPayable ?? goods);
    const cogsAmount = roundPKR(ctx.cogsAmount || 0);
    const lines = [
      line(ar._id, grand, 0, { partyEntityType: 'PHARMACY', partyEntityId: ctx.pharmacyId }),
      line(sales._id, 0, goods)
    ];

    if (ctx.taxSnapshot?.lines?.length) {
      const taxPosting = require('./tax/taxPosting.service');
      const taxLines = await taxPosting.buildTaxCreditGlLines(session, companyId, ctx.taxSnapshot);
      for (const tl of taxLines) {
        lines.push(line(tl.accountId, tl.debit, tl.credit));
      }
    }

    // Balance guard: if tax lines missing accounts, pad sales to keep voucher balanced
    const dr = roundPKR(lines.reduce((s, l) => s + (l.debit || 0), 0));
    const cr = roundPKR(lines.reduce((s, l) => s + (l.credit || 0), 0));
    if (Math.abs(dr - cr) > 0.001) {
      const diff = roundPKR(dr - cr);
      if (diff > 0) lines[1].credit = roundPKR(lines[1].credit + diff);
    }

    if (cogsAmount > 0 && cogs && inv) {
      lines.push(line(cogs._id, cogsAmount, 0));
      lines.push(line(inv._id, 0, cogsAmount));
    }

    const voucher = await glPosting.postVoucher(
      companyId,
      {
        voucherType: VOUCHER_TYPE.SV,
        date: ctx.date,
        narration: `Sales delivery ${ctx.invoiceNumber || ''}`.trim(),
        lines,
        sourceModule: GL_SOURCE_MODULE.ORDER,
        sourceRefId: ctx.deliveryId
      },
      reqUser,
      session
    );

    if (ctx.ledgerEntryId) await linkSubLedger(companyId, SUB_LEDGER_SOURCE.LEDGER, ctx.ledgerEntryId, voucher, 0, session);
    return voucher;
  } catch (err) {
    logger.warn({ msg: 'glBridge.postDeliveryGl.failed', companyId, err: err.message });
    return null;
  }
};

/**
 * Collection GL (prospective Model A):
 * - COMPANY collector: Dr Cash / Cr AR; if distributor share > 0 also Dr 6100 / Cr 2120.
 * - DISTRIBUTOR collector: Cr AR; Dr 2120 for company share; Dr 6100 for retained share. No company cash.
 */
const postCollectionGl = async (session, companyId, ctx, reqUser) => {
  const { COLLECTOR_TYPE } = require('../constants/enums');
  try {
    await ensureCoa(companyId, session);
    const ar = await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, session);
    const clearing = await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.DISTRIBUTOR_CLEARING, session);
    const opex = await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.OPERATING_EXPENSE, session);
    if (!ar) {
      throw new Error('Cannot post collection GL: accounts receivable (1130) is missing');
    }

    const amount = roundPKR(ctx.amount);
    const sliceCompany = roundPKR(ctx.sliceCompany != null ? ctx.sliceCompany : amount);
    const sliceDist = roundPKR(ctx.sliceDist != null ? ctx.sliceDist : 0);
    const isDistributor = ctx.collectorType === COLLECTOR_TYPE.DISTRIBUTOR;
    const lines = [];
    let moneyAcc = null;

    if (isDistributor) {
      if (!clearing) {
        throw new Error('Cannot post collection GL: distributor clearing (2120) is missing');
      }
      if (sliceCompany > 0.001 && clearing) {
        lines.push(
          line(clearing._id, sliceCompany, 0, {
            partyEntityType: 'DISTRIBUTOR_CLEARING',
            partyEntityId: ctx.distributorId
          })
        );
      }
      if (sliceDist > 0.001 && opex) {
        lines.push(line(opex._id, sliceDist, 0));
      }
      const dr = roundPKR(lines.reduce((s, l) => s + (l.debit || 0), 0));
      if (dr + 0.001 < amount && clearing) {
        lines.push(
          line(clearing._id, roundPKR(amount - dr), 0, {
            partyEntityType: 'DISTRIBUTOR_CLEARING',
            partyEntityId: ctx.distributorId
          })
        );
      }
      lines.push(line(ar._id, 0, amount, { partyEntityType: 'PHARMACY', partyEntityId: ctx.pharmacyId }));
    } else {
      moneyAcc = ctx.moneyAccountId
        ? await moneyAccountService.assertMoneyAccount(companyId, ctx.moneyAccountId, session)
        : await glPosting.getAccountByCode(
            companyId,
            paymentMethodToCashOrBank(ctx.paymentMethod),
            session
          );
      if (!moneyAcc) return null;
      lines.push(line(moneyAcc._id, amount, 0));
      lines.push(line(ar._id, 0, amount, { partyEntityType: 'PHARMACY', partyEntityId: ctx.pharmacyId }));
      const commissionSlices =
        ctx.clearingSlices && ctx.clearingSlices.length
          ? ctx.clearingSlices
          : [{ distributorId: ctx.distributorId, sliceDist, sliceCompany }];
      for (const s of commissionSlices) {
        const distShare = roundPKR(s.sliceDist || 0);
        if (distShare > 0.001 && clearing && opex) {
          lines.push(line(opex._id, distShare, 0));
          lines.push(
            line(clearing._id, 0, distShare, {
              partyEntityType: 'DISTRIBUTOR_CLEARING',
              partyEntityId: s.distributorId
            })
          );
        }
      }
    }

    const voucher = await glPosting.postVoucher(
      companyId,
      {
        voucherType: VOUCHER_TYPE.RV,
        date: ctx.date,
        narration: ctx.narration || 'Pharmacy collection',
        lines,
        sourceModule: GL_SOURCE_MODULE.COLLECTION,
        sourceRefId: ctx.collectionId,
        paymentMethod: ctx.paymentMethod,
        moneyAccountId: moneyAcc ? moneyAcc._id : null,
        moneyAccountNature: moneyAcc
          ? moneyAcc.moneyAccountNature || (moneyAcc.isBank ? 'BANK' : 'CASH')
          : null
      },
      reqUser,
      session
    );

    if (ctx.ledgerEntryIds?.length) {
      const arLineIdx = lines.findIndex((l) => String(l.accountId) === String(ar._id) && (l.credit || 0) > 0);
      const idx = arLineIdx >= 0 ? arLineIdx : Math.max(0, lines.length - 1);
      for (let i = 0; i < ctx.ledgerEntryIds.length; i++) {
        await linkSubLedger(companyId, SUB_LEDGER_SOURCE.LEDGER, ctx.ledgerEntryIds[i], voucher, idx, session);
      }
    }
    return voucher;
  } catch (err) {
    logger.warn({ msg: 'glBridge.postCollectionGl.failed', companyId, err: err.message });
    throw err;
  }
};

/**
 * Settlement GL:
 * - DISTRIBUTOR_TO_COMPANY: Dr money account / Cr 2120 (cash received = remittance).
 * - COMPANY_TO_DISTRIBUTOR: Dr 2120 / Cr money account (commission paid).
 */
const postSettlementGl = async (session, companyId, ctx, reqUser) => {
  const { SETTLEMENT_DIRECTION } = require('../constants/enums');
  try {
    await ensureCoa(companyId, session);
    const moneyAcc = await moneyAccountService.assertMoneyAccount(companyId, ctx.moneyAccountId, session);
    const clearing = await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.DISTRIBUTOR_CLEARING, session);
    if (!moneyAcc || !clearing) {
      throw new Error('Cannot post settlement GL: money account or distributor clearing (2120) is missing');
    }

    const amount = roundPKR(ctx.amount);
    const d2c = ctx.direction === SETTLEMENT_DIRECTION.DISTRIBUTOR_TO_COMPANY;
    const clearingExtra = {
      partyEntityType: 'DISTRIBUTOR_CLEARING',
      partyEntityId: ctx.distributorId
    };
    const lines = d2c
      ? [line(moneyAcc._id, amount, 0), line(clearing._id, 0, amount, clearingExtra)]
      : [line(clearing._id, amount, 0, clearingExtra), line(moneyAcc._id, 0, amount)];

    return glPosting.postVoucher(
      companyId,
      {
        voucherType: d2c ? VOUCHER_TYPE.RV : VOUCHER_TYPE.PV,
        date: ctx.date,
        narration: ctx.narration || (d2c ? 'Distributor remittance' : 'Settlement: company → distributor'),
        lines,
        sourceModule: GL_SOURCE_MODULE.SETTLEMENT,
        sourceRefId: ctx.settlementId,
        paymentMethod: ctx.paymentMethod,
        moneyAccountId: moneyAcc._id,
        moneyAccountNature: moneyAcc.moneyAccountNature || (moneyAcc.isBank ? 'BANK' : 'CASH')
      },
      reqUser,
      session
    );
  } catch (err) {
    logger.warn({ msg: 'glBridge.postSettlementGl.failed', companyId, err: err.message });
    throw err;
  }
};

/**
 * GRN / purchase: Dr Inventory / Cr AP.
 */
const postPurchaseGl = async (session, companyId, ctx, reqUser) => {
  try {
    await ensureCoa(companyId, session);
    const inv = await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.INVENTORY, session);
    const ap = await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.ACCOUNTS_PAYABLE, session);
    if (!inv || !ap) return null;

    const amount = roundPKR(ctx.amount);
    const voucher = await glPosting.postVoucher(
      companyId,
      {
        voucherType: VOUCHER_TYPE.PURV,
        date: ctx.date,
        narration: ctx.narration || 'Purchase / GRN',
        lines: [
          line(inv._id, amount, 0),
          line(ap._id, 0, amount, { partyEntityType: 'SUPPLIER', partyEntityId: ctx.supplierId })
        ],
        sourceModule: GL_SOURCE_MODULE.PROCUREMENT,
        sourceRefId: ctx.referenceId
      },
      reqUser,
      session
    );

    if (ctx.supplierLedgerEntryId) {
      await linkSubLedger(companyId, SUB_LEDGER_SOURCE.SUPPLIER_LEDGER, ctx.supplierLedgerEntryId, voucher, 1, session);
    }
    return voucher;
  } catch (err) {
    logger.warn({ msg: 'glBridge.postPurchaseGl.failed', companyId, err: err.message });
    return null;
  }
};

/**
 * Supplier payment: Dr AP / Cr Cash/Bank.
 */
const postSupplierPaymentGl = async (session, companyId, ctx, reqUser) => {
  try {
    await ensureCoa(companyId, session);
    const ap = await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.ACCOUNTS_PAYABLE, session);
    const cash = ctx.moneyAccountId
      ? await moneyAccountService.assertMoneyAccount(companyId, ctx.moneyAccountId, session)
      : await glPosting.getAccountByCode(
          companyId,
          paymentMethodToCashOrBank(ctx.paymentMethod),
          session
        );
    if (!ap || !cash) return null;

    const amount = roundPKR(ctx.amount);
    const voucher = await glPosting.postVoucher(
      companyId,
      {
        voucherType: VOUCHER_TYPE.PV,
        date: ctx.date,
        narration: ctx.narration || 'Supplier payment',
        lines: [
          line(ap._id, amount, 0, { partyEntityType: 'SUPPLIER', partyEntityId: ctx.supplierId }),
          line(cash._id, 0, amount)
        ],
        sourceModule: GL_SOURCE_MODULE.SUPPLIER,
        sourceRefId: ctx.supplierLedgerEntryId,
        paymentMethod: ctx.paymentMethod,
        moneyAccountId: cash._id,
        moneyAccountNature: cash.moneyAccountNature || (cash.isBank ? 'BANK' : 'CASH'),
        voucherNumber: ctx.voucherNumber || undefined
      },
      reqUser,
      session
    );

    if (ctx.supplierLedgerEntryId) {
      await linkSubLedger(companyId, SUB_LEDGER_SOURCE.SUPPLIER_LEDGER, ctx.supplierLedgerEntryId, voucher, 0, session);
    }
    return voucher;
  } catch (err) {
    logger.warn({ msg: 'glBridge.postSupplierPaymentGl.failed', companyId, err: err.message });
    return null;
  }
};

/**
 * Doctor activity investment: Dr Operating expense / Cr Cash or Bank money account.
 */
const postDoctorActivityGl = async (session, companyId, ctx, reqUser) => {
  await ensureCoa(companyId, session);

  const expAcc = ctx.expenseAccountId
    ? await Account.findOne({
        companyId: oid(companyId),
        _id: oid(ctx.expenseAccountId),
        groupType: 'EXPENSE',
        isGroup: { $ne: true },
        isControlAccount: { $ne: true },
        isActive: true,
        isDeleted: { $ne: true }
      }).session(session || null)
    : await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.OPERATING_EXPENSE, session);

  const cash = await moneyAccountService.assertMoneyAccount(companyId, ctx.moneyAccountId, session);

  if (!expAcc || !cash) {
    const ApiError = require('../utils/ApiError');
    throw new ApiError(400, 'Expense or money account not found — ensure Chart of Accounts is set up');
  }

  const amount = roundPKR(ctx.amount);
  return glPosting.postVoucher(
    companyId,
    {
      voucherType: VOUCHER_TYPE.PV,
      date: ctx.date,
      narration: ctx.narration || 'Doctor activity investment',
      lines: [line(expAcc._id, amount, 0), line(cash._id, 0, amount)],
      sourceModule: GL_SOURCE_MODULE.DOCTOR_ACTIVITY,
      sourceRefId: ctx.activityId,
      moneyAccountId: cash._id,
      moneyAccountNature: cash.moneyAccountNature || (cash.isBank ? 'BANK' : 'CASH')
    },
    reqUser,
    session
  );
};

/**
 * Expense payment voucher: Dr Expense account / Cr Cash or Bank money account.
 */
const postExpenseGl = async (session, companyId, ctx, reqUser) => {
  await ensureCoa(companyId, session);

  let expAcc;
  if (ctx.expenseAccountId) {
    expAcc = await Account.findOne({
      companyId: oid(companyId),
      _id: oid(ctx.expenseAccountId),
      groupType: 'EXPENSE',
      isGroup: { $ne: true },
      isControlAccount: { $ne: true },
      isActive: true,
      isDeleted: { $ne: true }
    }).session(session || null);
    if (!expAcc) {
      const ApiError = require('../utils/ApiError');
      throw new ApiError(400, 'Invalid expense account — select an expense category from Chart of Accounts');
    }
  } else if (ctx.category) {
    const expCode = expenseCategoryToCode(ctx.category);
    expAcc = await glPosting.getAccountByCode(companyId, expCode, session);
  }

  const cash = ctx.moneyAccountId
    ? await moneyAccountService.assertMoneyAccount(companyId, ctx.moneyAccountId, session)
    : await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.CASH, session);

  if (!expAcc || !cash) {
    const ApiError = require('../utils/ApiError');
    throw new ApiError(400, 'Expense or money account not found — ensure Chart of Accounts is set up');
  }

  const amount = roundPKR(ctx.amount);
  return glPosting.postVoucher(
    companyId,
    {
      voucherType: VOUCHER_TYPE.PV,
      date: ctx.date,
      narration: ctx.narration || `Expense: ${expAcc.name}`,
      lines: [line(expAcc._id, amount, 0), line(cash._id, 0, amount)],
      sourceModule: GL_SOURCE_MODULE.EXPENSE,
      sourceRefId: ctx.expenseId,
      moneyAccountId: cash._id,
      moneyAccountNature: cash.moneyAccountNature || (cash.isBank ? 'BANK' : 'CASH')
    },
    reqUser,
    session
  );
};

/**
 * Return / amendment credit: Dr Sales Returns (goods) + Dr Tax Payable (tax) / Cr AR (goods+tax).
 * ctx.amount = total AR credit (grand). Optional ctx.goodsAmount + ctx.taxLineCredits for split.
 */
const postReturnGl = async (session, companyId, ctx, reqUser) => {
  try {
    await ensureCoa(companyId, session);
    const ar = await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, session);
    const ret = await glPosting.getAccountByCode(companyId, ACCOUNT_CODES.SALES_RETURNS, session);
    if (!ar || !ret) return null;

    const total = roundPKR(ctx.amount);
    const goodsAmount =
      ctx.goodsAmount != null ? roundPKR(ctx.goodsAmount) : total;
    const taxPosting = require('./tax/taxPosting.service');
    const taxLines = await taxPosting.buildTaxReversalGlLines(
      session,
      companyId,
      ctx.taxLineCredits || []
    );
    const taxDr = roundPKR(taxLines.reduce((s, l) => s + (l.debit || 0), 0));
    const salesReturnsDr = roundPKR(Math.max(0, total - taxDr));

    const lines = [
      line(ret._id, salesReturnsDr > 0 ? salesReturnsDr : goodsAmount, 0),
      ...taxLines.map((tl) => line(tl.accountId, tl.debit, tl.credit)),
      line(ar._id, 0, total, { partyEntityType: 'PHARMACY', partyEntityId: ctx.pharmacyId })
    ];

    // Rebalance if needed
    const dr = roundPKR(lines.reduce((s, l) => s + (l.debit || 0), 0));
    const cr = roundPKR(lines.reduce((s, l) => s + (l.credit || 0), 0));
    if (Math.abs(dr - cr) > 0.001) {
      lines[0].debit = roundPKR(lines[0].debit + (cr - dr));
    }

    const voucher = await glPosting.postVoucher(
      companyId,
      {
        voucherType: VOUCHER_TYPE.SV,
        date: ctx.date,
        narration: ctx.narration || 'Sales return',
        lines,
        sourceModule: GL_SOURCE_MODULE.ORDER,
        sourceRefId: ctx.returnId
      },
      reqUser,
      session
    );

    const arLineIdx = lines.length - 1;
    if (ctx.ledgerEntryId) {
      await linkSubLedger(companyId, SUB_LEDGER_SOURCE.LEDGER, ctx.ledgerEntryId, voucher, arLineIdx, session);
    }
    return voucher;
  } catch (err) {
    logger.warn({ msg: 'glBridge.postReturnGl.failed', companyId, err: err.message });
    return null;
  }
};

/**
 * Contra / fund transfer: Dr destination / Cr source.
 */
const postFundTransferGl = async (
  companyId,
  { fromAccountId, toAccountId, fromMoneyAccountId, toMoneyAccountId, amount, date, narration },
  reqUser,
  session = null
) => {
  await ensureCoa(companyId, session);
  const fromId = fromMoneyAccountId || fromAccountId;
  const toId = toMoneyAccountId || toAccountId;
  const fromAcc = await moneyAccountService.assertMoneyAccount(companyId, fromId, session);
  const toAcc = await moneyAccountService.assertMoneyAccount(companyId, toId, session);
  if (String(fromAcc._id) === String(toAcc._id)) {
    throw new Error('Source and destination money accounts must differ');
  }
  const amt = roundPKR(amount);
  if (amt <= 0) throw new Error('Amount must be positive');

  return glPosting.postVoucher(
    companyId,
    {
      voucherType: VOUCHER_TYPE.CV,
      date: date || new Date(),
      narration: narration || 'Fund transfer',
      lines: [line(toAcc._id, amt, 0), line(fromAcc._id, 0, amt)],
      sourceModule: GL_SOURCE_MODULE.FUND_TRANSFER,
      moneyAccountId: fromAcc._id,
      toMoneyAccountId: toAcc._id,
      moneyAccountNature: fromAcc.moneyAccountNature || (fromAcc.isBank ? 'BANK' : 'CASH')
    },
    reqUser,
    session
  );
};

const reconcileControlAccount = async (companyId, controlAccountCode) => {
  const acc = await glPosting.getAccountByCode(companyId, controlAccountCode);
  if (!acc) return null;
  return {
    accountId: acc._id,
    accountCode: acc.code,
    accountName: acc.name,
    glBalance: acc.currentBalance
  };
};

module.exports = {
  postDeliveryGl,
  postCollectionGl,
  postSettlementGl,
  postPurchaseGl,
  postSupplierPaymentGl,
  postDoctorActivityGl,
  postExpenseGl,
  postReturnGl,
  postFundTransferGl,
  reconcileControlAccount,
  ensureCoa
};
