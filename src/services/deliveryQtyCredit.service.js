/**
 * Shared qty-credit adjustment core for Returns and Amendments.
 * Business documents differ; inventory / money / GL / clearing / packs / doctor hooks are shared.
 */
const mongoose = require('mongoose');
const DistributorInventory = require('../models/DistributorInventory');
const DeliveryRecord = require('../models/DeliveryRecord');
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
 * Compute proportional pharmacy credit / shares / cost from a delivery line snapshot.
 * @param {object|null} dLine
 * @param {number} creditQty physical packs to credit
 */
const computeQtyCreditAgainstDeliveryLine = (dLine, creditQty) => {
  const qty = Number(creditQty) || 0;
  const avgCostAtTime = dLine?.avgCostAtTime || 0;
  const finalSellingPrice = dLine?.finalSellingPrice || 0;
  const lineQty = dLine?.quantity > 0 ? dLine.quantity : qty;
  const linePharmacyNet =
    dLine?.linePharmacyNet != null
      ? roundPKR(dLine.linePharmacyNet)
      : roundPKR(finalSellingPrice * lineQty);

  const creditAmount =
    dLine?.linePharmacyNet != null
      ? roundPKR((linePharmacyNet / lineQty) * qty)
      : roundPKR(finalSellingPrice * qty);

  const lineCost = roundPKR(avgCostAtTime * qty);
  const totalProfit = roundPKR(creditAmount - lineCost);
  const profitPerUnit = qty > 0 ? roundPKR(totalProfit / qty) : 0;

  const companyShare =
    dLine && dLine.companyShare != null
      ? roundPKR((dLine.companyShare / lineQty) * qty)
      : roundPKR(
          creditAmount -
            (dLine && dLine.distributorShare != null
              ? roundPKR((dLine.distributorShare / lineQty) * qty)
              : 0)
        );

  const distributorShare =
    dLine && dLine.distributorShare != null
      ? roundPKR((dLine.distributorShare / lineQty) * qty)
      : roundPKR(creditAmount - companyShare);

  return {
    avgCostAtTime,
    finalSellingPrice,
    lineQty,
    linePharmacyNet,
    creditAmount,
    lineCost,
    totalProfit,
    profitPerUnit,
    companyShare,
    distributorShare
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
      date: ctx.date,
      narration: ctx.narration,
      ledgerEntryId: ctx.ledgerEntryId
    },
    reqUser
  );
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
  computeQtyCreditAgainstDeliveryLine,
  restockDistributorQty,
  buildCreditAllocationsFromMap,
  buildPharmacyCreditMeta,
  postPharmacyDocumentCredit,
  postSalesCreditGl,
  postQtyCreditClearingForLines,
  adjustMedRepPacks,
  applyDoctorTpCredit,
  postQtyCreditTransaction,
  getBusinessMonthKey,
  TRANSACTION_TYPE,
  LEDGER_REFERENCE_TYPE
};
