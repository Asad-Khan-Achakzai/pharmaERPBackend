const mongoose = require('mongoose');
const TaxRegisterEntry = require('../../models/TaxRegisterEntry');
const DeliveryRecord = require('../../models/DeliveryRecord');
const ApiError = require('../../utils/ApiError');
const { roundPKR } = require('../../utils/currency');
const {
  TAX_POSTING_STATUS,
  TAX_REGISTER_ENTRY_TYPE,
  TAX_REGISTER_STATUS,
  TAX_REGISTER_DIRECTION,
  TAX_POSTING_BEHAVIOR,
  TAX_POSTING_VERSION
} = require('../../constants/taxCatalog');
const taxCoa = require('./taxCoa.service');
const glPosting = require('../glPosting.service');
const logger = require('../../utils/logger');

const oid = (id) => new mongoose.Types.ObjectId(String(id));

/**
 * Expand a goods-only credit using the delivery's frozen tax snapshot.
 * Uses original rates/ratios — never recalculates from live config.
 */
const expandGoodsCreditWithTax = (delivery, goodsCredit) => {
  const goods = roundPKR(Math.max(0, Number(goodsCredit) || 0));
  const goodsNet = roundPKR(
    delivery?.goodsNetPayable ?? delivery?.pharmacyNetPayable ?? delivery?.totalAmount ?? 0
  );
  const taxTotal = roundPKR(delivery?.taxTotal || delivery?.taxSnapshot?.amounts?.taxTotal || 0);
  if (goods <= 0 || taxTotal <= 0 || goodsNet <= 0) {
    return { goodsCredit: goods, taxCredit: 0, totalCredit: goods, lineTaxCredits: [] };
  }

  const ratio = Math.min(1, goods / goodsNet);
  const taxCredit = roundPKR(taxTotal * ratio);
  const lines = delivery?.taxSnapshot?.lines || [];
  const lineTaxCredits = lines.map((l, idx) => ({
    snapshotLineRef: l.sequence ?? idx + 1,
    taxTypeCode: l.taxTypeCode,
    taxSection: l.taxSection || '',
    ratePercent: l.ratePercent,
    calculationBase: l.calculationBase || '',
    taxRuleId: l.taxRuleId,
    rateVersionId: l.rateVersionId,
    liabilityAccountCode: l.liabilityAccountCode,
    postingBehavior: l.postingBehavior,
    taxAmount: roundPKR((Number(l.taxAmount) || 0) * ratio),
    taxableAmount: roundPKR((Number(l.calculationBaseAmount) || 0) * ratio)
  }));

  return {
    goodsCredit: goods,
    taxCredit,
    totalCredit: roundPKR(goods + taxCredit),
    lineTaxCredits
  };
};

/**
 * Write Tax Register rows + mark delivery posting status.
 * Does not post Ledger (caller posts AR) or invent tax amounts.
 *
 * @returns {{ registerEntries: object[], taxTotal: number, invoiceGrandTotal: number, goodsNetPayable: number }}
 */
const postInvoiceTax = async ({
  session,
  companyId,
  delivery,
  pharmacyId,
  orderId,
  voucherId = null,
  reqUser = null
}) => {
  const snapshot = delivery.taxSnapshot;
  const goods = roundPKR(delivery.goodsNetPayable ?? delivery.pharmacyNetPayable ?? 0);
  const taxTotal = roundPKR(delivery.taxTotal || 0);
  const grand = roundPKR(delivery.invoiceGrandTotal ?? goods);

  if (!snapshot || !Array.isArray(snapshot.lines) || snapshot.lines.length === 0) {
    await DeliveryRecord.updateOne(
      { _id: delivery._id },
      { $set: { taxPostingStatus: TAX_POSTING_STATUS.NOT_APPLICABLE } },
      { session }
    );
    return { registerEntries: [], taxTotal: 0, invoiceGrandTotal: goods, goodsNetPayable: goods };
  }

  await taxCoa.ensureTaxLiabilityAccounts(companyId, null, session);

  const entries = [];
  for (const line of snapshot.lines) {
    if (line.postingBehavior === TAX_POSTING_BEHAVIOR.INFO_ONLY) continue;
    const [row] = await TaxRegisterEntry.create(
      [
        {
          companyId: oid(companyId),
          entryType: TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX,
          status: TAX_REGISTER_STATUS.OPEN,
          taxTypeCode: line.taxTypeCode,
          taxSection: line.taxSection || '',
          ratePercent: line.ratePercent,
          calculationBase: line.calculationBase || '',
          taxableAmount: roundPKR(line.calculationBaseAmount || 0),
          taxAmount: roundPKR(line.taxAmount || 0),
          direction: TAX_REGISTER_DIRECTION.PAYABLE,
          businessDate: snapshot.businessDate || delivery.deliveredAt || new Date(),
          pharmacyId: pharmacyId ? oid(pharmacyId) : null,
          deliveryId: oid(delivery._id),
          invoiceNumber: delivery.invoiceNumber || '',
          taxRuleId: line.taxRuleId || null,
          rateVersionId: line.rateVersionId || null,
          snapshotLineRef: line.sequence,
          voucherId: voucherId || null,
          createdBy: reqUser?.userId || reqUser?._id || null,
          meta: { orderId: orderId ? oid(orderId) : undefined }
        }
      ],
      { session, ordered: true }
    );
    entries.push(row);
  }

  await DeliveryRecord.updateOne(
    { _id: delivery._id },
    {
      $set: {
        taxPostingStatus: TAX_POSTING_STATUS.POSTED,
        'taxSnapshot.postingVersion': TAX_POSTING_VERSION
      }
    },
    { session }
  );

  return {
    registerEntries: entries,
    taxTotal,
    invoiceGrandTotal: grand,
    goodsNetPayable: goods
  };
};

/**
 * Reverse tax for return/amendment against one or more deliveries.
 * Creates TAX_REVERSAL register rows (negative taxAmount, status OPEN).
 * Never mutates remitted / deposit-linked historical invoice tax rows —
 * post-remittance returns become open adjustments for the next filing period.
 */
const reverseInvoiceTax = async ({
  session,
  companyId,
  pharmacyId,
  businessDate,
  referenceType, // 'RETURN' | 'AMENDMENT'
  referenceId,
  /** Map deliveryId -> goodsCredit */
  goodsCreditByDelivery,
  voucherId = null,
  reqUser = null
}) => {
  const auditService = require('../audit.service');
  const reversals = [];
  let totalTaxCredit = 0;

  for (const [deliveryId, goodsCredit] of goodsCreditByDelivery.entries()) {
    const delivery = await DeliveryRecord.findOne({
      _id: deliveryId,
      companyId,
      isDeleted: { $ne: true }
    })
      .session(session)
      .lean();
    if (!delivery) continue;

    const { taxCredit, lineTaxCredits } = expandGoodsCreditWithTax(delivery, goodsCredit);
    if (taxCredit <= 0 && !lineTaxCredits.length) continue;

    totalTaxCredit = roundPKR(totalTaxCredit + taxCredit);

    const originalEntries = await TaxRegisterEntry.find({
      companyId: oid(companyId),
      deliveryId: oid(deliveryId),
      entryType: TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX,
      isDeleted: { $ne: true }
    })
      .session(session)
      .lean();

    for (const lt of lineTaxCredits) {
      if (lt.taxAmount <= 0) continue;
      const related = originalEntries.find(
        (o) =>
          o.snapshotLineRef === lt.snapshotLineRef ||
          (o.taxTypeCode === lt.taxTypeCode && o.taxSection === (lt.taxSection || ''))
      );
      const wasRemitted =
        related &&
        [
          TAX_REGISTER_STATUS.REMITTED,
          TAX_REGISTER_STATUS.CLEARED,
          TAX_REGISTER_STATUS.INCLUDED_IN_DEPOSIT,
          TAX_REGISTER_STATUS.PARTIALLY_CLEARED
        ].includes(related.status);

      const [row] = await TaxRegisterEntry.create(
        [
          {
            companyId: oid(companyId),
            entryType: TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL,
            status: TAX_REGISTER_STATUS.OPEN,
            taxTypeCode: lt.taxTypeCode,
            taxSection: lt.taxSection || '',
            ratePercent: lt.ratePercent,
            calculationBase: lt.calculationBase || related?.calculationBase || '',
            taxableAmount: roundPKR(-Math.abs(lt.taxableAmount || 0)),
            taxAmount: roundPKR(-Math.abs(lt.taxAmount || 0)),
            direction: TAX_REGISTER_DIRECTION.PAYABLE,
            businessDate: businessDate || new Date(),
            pharmacyId: pharmacyId ? oid(pharmacyId) : null,
            deliveryId: oid(deliveryId),
            invoiceNumber: delivery.invoiceNumber || '',
            taxRuleId: lt.taxRuleId || null,
            rateVersionId: lt.rateVersionId || null,
            snapshotLineRef: lt.snapshotLineRef,
            voucherId: voucherId || null,
            createdBy: reqUser?.userId || reqUser?._id || null,
            meta: {
              returnId: referenceType === 'RETURN' ? oid(referenceId) : undefined,
              amendmentId: referenceType === 'AMENDMENT' ? oid(referenceId) : undefined,
              relatedRemittedEntryId: related?._id,
              narration: wasRemitted
                ? `${referenceType} tax adjustment (original already remitted — next filing period)`
                : `${referenceType} tax reversal`
            }
          }
        ],
        { session, ordered: true }
      );
      reversals.push(row);

      if (wasRemitted) {
        await auditService.logInSession(session, {
          companyId,
          userId: reqUser?.userId || reqUser?._id || null,
          action: 'TAX_ADJUSTMENT_CREATED',
          entityType: 'TaxRegisterEntry',
          entityId: row._id,
          changes: {
            reason: 'return_after_remittance',
            relatedEntryId: related?._id,
            taxAmount: row.taxAmount,
            deliveryId
          }
        });
      }
    }

    // Update delivery posting status
    const netTax = await TaxRegisterEntry.aggregate([
      {
        $match: {
          companyId: oid(companyId),
          deliveryId: oid(deliveryId),
          isDeleted: { $ne: true },
          entryType: {
            $in: [TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX, TAX_REGISTER_ENTRY_TYPE.TAX_REVERSAL]
          }
        }
      },
      { $group: { _id: null, sum: { $sum: '$taxAmount' } } }
    ]).session(session);

    const remaining = roundPKR(netTax[0]?.sum || 0);
    const status =
      remaining <= 0.001
        ? TAX_POSTING_STATUS.REVERSED
        : remaining < roundPKR(delivery.taxTotal || 0)
          ? TAX_POSTING_STATUS.PARTIALLY_REVERSED
          : TAX_POSTING_STATUS.POSTED;

    await DeliveryRecord.updateOne(
      { _id: deliveryId },
      { $set: { taxPostingStatus: status } },
      { session }
    );
  }

  return { reversals, totalTaxCredit, lineTaxCreditsByDelivery: goodsCreditByDelivery };
};

/**
 * Legacy remittance API — creates a TaxDeposit and submits it (whole entries only).
 * Does not mutate historical taxAmount on register rows.
 */
const postRemittance = async (companyId, body, reqUser) => {
  const taxDepositService = require('./taxDeposit.service');

  let entryIds = Array.isArray(body.registerEntryIds) ? body.registerEntryIds.map(String) : [];
  if (!entryIds.length) {
    const filter = {
      companyId: oid(companyId),
      status: TAX_REGISTER_STATUS.OPEN,
      entryType: TAX_REGISTER_ENTRY_TYPE.INVOICE_TAX,
      isDeleted: { $ne: true },
      taxAmount: { $gt: 0 }
    };
    if (body.taxTypeCode) filter.taxTypeCode = body.taxTypeCode;
    const open = await TaxRegisterEntry.find(filter).sort({ businessDate: 1 }).lean();
    let remaining = roundPKR(body.amount);
    for (const e of open) {
      if (remaining <= 0.001) break;
      if (e.taxAmount <= remaining + 0.001) {
        entryIds.push(String(e._id));
        remaining = roundPKR(remaining - e.taxAmount);
      }
      // skip partial entry inclusion — whole entries only
    }
  }
  if (!entryIds.length) throw new ApiError(400, 'No open tax register amount to remit');

  const deposit = await taxDepositService.createDeposit(
    companyId,
    {
      moneyAccountId: body.moneyAccountId,
      paymentDate: body.businessDate,
      notes: body.narration || 'Tax remittance to government',
      governmentAuthority: body.governmentAuthority || 'FBR',
      registerEntryIds: entryIds
    },
    reqUser
  );

  const submitted = await taxDepositService.submitDeposit(
    companyId,
    deposit._id,
    {
      moneyAccountId: body.moneyAccountId,
      paymentDate: body.businessDate,
      narration: body.narration
    },
    reqUser
  );

  return {
    remitted: submitted.amount,
    unallocated: 0,
    voucherId: submitted.voucherId,
    depositId: submitted._id,
    depositNumber: submitted.depositNumber,
    clearedCount: (submitted.entries || []).length
  };
};

/**
 * Build GL tax credit lines from snapshot (for delivery SV).
 */
const buildTaxCreditGlLines = async (session, companyId, snapshot) => {
  const lines = [];
  if (!snapshot?.lines?.length) return lines;
  const byAccount = {};
  for (const l of snapshot.lines) {
    if (l.postingBehavior === TAX_POSTING_BEHAVIOR.INFO_ONLY) continue;
    if (l.postingBehavior === TAX_POSTING_BEHAVIOR.DEDUCT_FROM_RECEIVABLE) continue; // WHT handled separately if needed
    const code = l.liabilityAccountCode || '2140';
    byAccount[code] = roundPKR((byAccount[code] || 0) + (l.taxAmount || 0));
  }
  for (const [code, amt] of Object.entries(byAccount)) {
    if (amt <= 0) continue;
    let acc = await glPosting.getAccountByCode(companyId, code, session);
    if (!acc) {
      await taxCoa.ensureTaxLiabilityAccounts(companyId, null, session);
      acc = await glPosting.getAccountByCode(companyId, code, session);
    }
    if (!acc) {
      logger.warn({ msg: 'taxPosting.missingLiabilityAccount', code, companyId: String(companyId) });
      continue;
    }
    lines.push({ accountId: acc._id, debit: 0, credit: amt });
  }
  return lines;
};

/**
 * Build GL debit lines to reverse tax liability (returns).
 */
const buildTaxReversalGlLines = async (session, companyId, lineTaxCredits) => {
  const byAccount = {};
  for (const l of lineTaxCredits || []) {
    if (l.postingBehavior === TAX_POSTING_BEHAVIOR.INFO_ONLY) continue;
    const code = l.liabilityAccountCode || '2140';
    byAccount[code] = roundPKR((byAccount[code] || 0) + Math.abs(l.taxAmount || 0));
  }
  const lines = [];
  for (const [code, amt] of Object.entries(byAccount)) {
    if (amt <= 0) continue;
    let acc = await glPosting.getAccountByCode(companyId, code, session);
    if (!acc) {
      await taxCoa.ensureTaxLiabilityAccounts(companyId, null, session);
      acc = await glPosting.getAccountByCode(companyId, code, session);
    }
    if (!acc) continue;
    lines.push({ accountId: acc._id, debit: amt, credit: 0 });
  }
  return lines;
};

module.exports = {
  postInvoiceTax,
  reverseInvoiceTax,
  postRemittance,
  expandGoodsCreditWithTax,
  buildTaxCreditGlLines,
  buildTaxReversalGlLines
};
