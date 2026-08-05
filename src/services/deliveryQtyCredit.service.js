/**
 * Shared qty-credit adjustment core for Returns and Amendments.
 * Business documents differ; inventory / money / GL / clearing / packs / doctor hooks are shared.
 *
 * Money allocation uses qtyCreditAllocation.service (v1: BONUS_FIRST).
 * Physical inventory / TP / packs always reverse the full physical delta.
 */
const mongoose = require('mongoose');
const DistributorInventory = require('../models/DistributorInventory');
const DeliveryRecord = require('../models/DeliveryRecord');
const ReturnRecord = require('../models/ReturnRecord');
const OrderAmendment = require('../models/OrderAmendment');
const Ledger = require('../models/Ledger');
const MedRepTarget = require('../models/MedRepTarget');
const Transaction = require('../models/Transaction');
const { roundPKR } = require('../utils/currency');
const { utcNow, getBusinessMonthKey } = require('../utils/businessTime');
const {
  LEDGER_TYPE,
  LEDGER_ENTITY_TYPE,
  LEDGER_REFERENCE_TYPE,
  TRANSACTION_TYPE
} = require('../constants/enums');
const doctorActivityService = require('./doctorActivity.service');
const financialService = require('./financial.service');
const glBridge = require('./glBridge.service');
const qtyAlloc = require('./qtyCreditAllocation.service');

/**
 * Resolve latest delivery line snapshot for a product on an order.
 */
const findLatestDeliveryLine = async (session, companyId, orderId, productId) => {
  const lastDelivery = await DeliveryRecord.findOne({
    companyId,
    orderId,
    'items.productId': productId
  })
    .sort({ deliveredAt: -1 })
    .session(session);

  const dLine = lastDelivery?.items?.find((i) => i.productId.toString() === String(productId));
  return { lastDelivery, dLine };
};

/**
 * Prior return/amendment credits for a product on an order (for remaining paid/bonus pool).
 * Historical rows without paidDelta/bonusDelta are returned as physical-only (policy applied at plan time).
 */
const loadPriorQtyCreditsForProduct = async (session, companyId, orderId, productId) => {
  const pid = String(productId);
  const q = { companyId, orderId, isDeleted: { $ne: true } };
  let retQuery = ReturnRecord.find(q).select('items').lean();
  let amdQuery = OrderAmendment.find(q).select('items').lean();
  if (session) {
    retQuery = retQuery.session(session);
    amdQuery = amdQuery.session(session);
  }
  const [returns, amendments] = await Promise.all([retQuery, amdQuery]);

  const prior = [];
  for (const r of returns || []) {
    for (const it of r.items || []) {
      if (String(it.productId) !== pid) continue;
      prior.push({
        physicalQty: Number(it.quantity) || 0,
        paidDelta: it.paidDelta,
        bonusDelta: it.bonusDelta
      });
    }
  }
  for (const a of amendments || []) {
    for (const it of a.items || []) {
      if (String(it.productId) !== pid) continue;
      prior.push({
        physicalQty: Number(it.deltaQty) || 0,
        paidDelta: it.paidDelta,
        bonusDelta: it.bonusDelta
      });
    }
  }
  return prior;
};

/**
 * Plan a qty credit against a delivery line using the official allocation policy (Bonus-First v1).
 * @param {object|null} dLine
 * @param {number} creditQty physical packs to credit
 * @param {{ priorCredits?: Array, policy?: string }} [opts]
 */
const computeQtyCreditAgainstDeliveryLine = (dLine, creditQty, opts = {}) => {
  const plan = qtyAlloc.planQtyCredit({
    dLine,
    physicalDelta: creditQty,
    priorCredits: opts.priorCredits || [],
    policy: opts.policy || qtyAlloc.DEFAULT_QTY_CREDIT_ALLOCATION_POLICY
  });
  return {
    avgCostAtTime: plan.avgCostAtTime,
    finalSellingPrice: plan.finalSellingPrice,
    lineQty: plan.lineQty,
    linePharmacyNet: plan.linePharmacyNet,
    creditAmount: plan.creditAmount,
    lineCost: plan.lineCost,
    totalProfit: plan.totalProfit,
    profitPerUnit: plan.profitPerUnit,
    companyShare: plan.companyShare,
    distributorShare: plan.distributorShare,
    paidDelta: plan.paidDelta,
    bonusDelta: plan.bonusDelta,
    physicalDelta: plan.physicalDelta,
    paidUnitNet: plan.paidUnitNet,
    allocationPolicy: plan.policy,
    composition: plan.composition
  };
};

const restockDistributorQty = async (session, { companyId, distributorId, productId, quantity }) => {
  await DistributorInventory.updateOne(
    { companyId, distributorId, productId },
    { $inc: { quantity }, $set: { lastUpdated: utcNow() } },
    { session }
  );
};

const buildCreditAllocationsFromMap = (creditByDelivery) =>
  [...creditByDelivery.entries()].map(([deliveryId, amount]) => ({
    deliveryId: new mongoose.Types.ObjectId(deliveryId),
    amount: roundPKR(amount)
  }));

const buildPharmacyCreditMeta = (orderId, creditByDelivery) => {
  const meta = { orderId };
  if (creditByDelivery.size === 1) {
    meta.deliveryId = new mongoose.Types.ObjectId([...creditByDelivery.keys()][0]);
  } else if (creditByDelivery.size > 1) {
    meta.allocations = [...creditByDelivery.entries()].map(([deliveryId, amount]) => ({
      deliveryId: new mongoose.Types.ObjectId(deliveryId),
      amount
    }));
  }
  return meta;
};

/**
 * Pharmacy receivable CREDIT (money SoT). referenceType distinguishes RETURN vs AMENDMENT.
 */
const postPharmacyDocumentCredit = async (
  session,
  {
    companyId,
    pharmacyId,
    amount,
    referenceType,
    referenceId,
    description,
    date,
    meta
  }
) => {
  const [entry] = await Ledger.create(
    [
      {
        companyId,
        entityType: LEDGER_ENTITY_TYPE.PHARMACY,
        entityId: pharmacyId,
        type: LEDGER_TYPE.CREDIT,
        amount: roundPKR(amount),
        referenceType,
        referenceId,
        description,
        date,
        meta
      }
    ],
    { session, ordered: true }
  );
  return entry;
};

/**
 * GL: Dr Sales Returns / Cr AR. Uses shared bridge (same as returns).
 */
const postSalesCreditGl = async (session, companyId, ctx, reqUser) => {
  return glBridge.postReturnGl(
    session,
    companyId,
    {
      pharmacyId: ctx.pharmacyId,
      returnId: ctx.sourceRefId,
      amount: ctx.amount,
      goodsAmount: ctx.goodsAmount,
      taxLineCredits: ctx.taxLineCredits,
      date: ctx.date,
      narration: ctx.narration,
      ledgerEntryId: ctx.ledgerEntryId
    },
    reqUser
  );
};

/**
 * Expand goods credits per delivery with frozen tax; returns totals + flat tax line credits.
 * Mutates creditByDelivery map values from goods → grand when tax applies.
 */
const applyTaxToCreditByDelivery = async (session, companyId, creditByDelivery) => {
  const taxPosting = require('./tax/taxPosting.service');
  const allTaxLines = [];
  let goodsTotal = 0;
  let taxTotal = 0;
  for (const [deliveryId, goodsAmt] of [...creditByDelivery.entries()]) {
    const delivery = await DeliveryRecord.findOne({
      _id: deliveryId,
      companyId,
      isDeleted: { $ne: true }
    })
      .session(session)
      .lean();
    const goods = roundPKR(goodsAmt);
    goodsTotal = roundPKR(goodsTotal + goods);
    const expanded = taxPosting.expandGoodsCreditWithTax(delivery, goods);
    creditByDelivery.set(deliveryId, expanded.totalCredit);
    taxTotal = roundPKR(taxTotal + expanded.taxCredit);
    for (const lt of expanded.lineTaxCredits) {
      if (lt.taxAmount > 0) allTaxLines.push(lt);
    }
  }
  return {
    goodsTotal,
    taxTotal,
    grandTotal: roundPKR(goodsTotal + taxTotal),
    taxLineCredits: allTaxLines
  };
};

/**
 * Proportional distributor clearing reverse for each credited line against its delivery.
 */
const postQtyCreditClearingForLines = async (
  session,
  {
    companyId,
    distributorId,
    orderId,
    lines,
    documentId,
    date,
    clearingReferenceType = LEDGER_REFERENCE_TYPE.RETURN_CLEARING_ADJ
  }
) => {
  for (const row of lines) {
    const creditLineAmount = roundPKR(row.creditAmount ?? row.finalSellingPrice * row.quantity);
    const { lastDelivery, dLine: line } = await findLatestDeliveryLine(
      session,
      companyId,
      orderId,
      row.productId
    );
    if (!lastDelivery || !line) continue;
    const linePharmacyNet = roundPKR(line.linePharmacyNet ?? line.finalSellingPrice * line.quantity);
    if (linePharmacyNet <= 0) continue;
    const f = Math.min(1, creditLineAmount / linePharmacyNet);
    const lineCompany =
      line.companyShare != null
        ? roundPKR(line.companyShare)
        : roundPKR(linePharmacyNet - (line.distributorShare || 0));
    const lineDist = line.distributorShare != null ? roundPKR(line.distributorShare) : 0;
    await financialService.postReturnClearingAdjustment(session, {
      companyId,
      distributorId,
      deliveryId: lastDelivery._id,
      orderId,
      fraction: f,
      companyShareTotal: lineCompany,
      distributorShareTotal: lineDist,
      returnRecordId: documentId,
      date,
      referenceType: clearingReferenceType
    });
  }
};

/**
 * @deprecated Packs progress is recomputed via medRepTargetAchieved.syncAchievedPacksForRepMonth
 * after delivery / return / amendment commit. Kept only for any legacy callers.
 */
const adjustMedRepPacks = async (session, { companyId, medicalRepId, month, packDelta }) => {
  await MedRepTarget.updateOne(
    { companyId, medicalRepId, month, isDeleted: { $ne: true } },
    { $inc: { achievedPacks: packDelta } },
    { session }
  );
};

const applyDoctorTpCredit = async (session, companyId, { doctorId, tpAmount, at }) => {
  if (!doctorId || !tpAmount || tpAmount <= 0) return;
  await doctorActivityService.applyReturnTp(session, companyId, {
    doctorId,
    tpAmount,
    returnedAt: at
  });
};

const postQtyCreditTransaction = async (
  session,
  {
    companyId,
    type,
    referenceType,
    referenceId,
    totalAmount,
    totalCost,
    totalProfit,
    date,
    description
  }
) => {
  await Transaction.create(
    [
      {
        companyId,
        type,
        referenceType,
        referenceId,
        revenue: -roundPKR(totalAmount),
        cost: -roundPKR(totalCost),
        profit: -roundPKR(totalProfit),
        date,
        description
      }
    ],
    { session, ordered: true }
  );
};

module.exports = {
  findLatestDeliveryLine,
  loadPriorQtyCreditsForProduct,
  computeQtyCreditAgainstDeliveryLine,
  restockDistributorQty,
  buildCreditAllocationsFromMap,
  buildPharmacyCreditMeta,
  postPharmacyDocumentCredit,
  postSalesCreditGl,
  applyTaxToCreditByDelivery,
  postQtyCreditClearingForLines,
  adjustMedRepPacks,
  applyDoctorTpCredit,
  postQtyCreditTransaction,
  getBusinessMonthKey,
  TRANSACTION_TYPE,
  LEDGER_REFERENCE_TYPE,
  DEFAULT_QTY_CREDIT_ALLOCATION_POLICY: qtyAlloc.DEFAULT_QTY_CREDIT_ALLOCATION_POLICY,
  QTY_CREDIT_ALLOCATION_POLICY: qtyAlloc.QTY_CREDIT_ALLOCATION_POLICY
};
