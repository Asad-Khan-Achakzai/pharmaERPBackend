/**
 * Post-delivery order amendments (v1: QUANTITY_REDUCTION only).
 * Uses shared deliveryQtyCredit core; distinct OrderAmendment document.
 */
const mongoose = require('mongoose');
const Order = require('../models/Order');
const OrderAmendment = require('../models/OrderAmendment');
const DeliveryRecord = require('../models/DeliveryRecord');
const ApiError = require('../utils/ApiError');
const { roundPKR } = require('../utils/currency');
const { getNextSequenceNumber } = require('../utils/orderNumber');
const { utcNow, getBusinessMonthKey, requireCompanyIanaZone } = require('../utils/businessTime');
const {
  ORDER_STATUS,
  AMENDMENT_TYPE,
  AMENDMENT_SOURCE,
  AMENDMENT_STATUS,
  LEDGER_REFERENCE_TYPE,
  TRANSACTION_TYPE
} = require('../constants/enums');
const {
  remainingAmendableQty,
  deltaQtyForNewRemaining
} = require('../utils/orderQty.util');
const { assertOrderVisibleToUser } = require('../utils/orderScope.util');
const qtyCredit = require('./deliveryQtyCredit.service');
const creditNoteService = require('./creditNote.service');
const auditService = require('./audit.service');
const medRepTargetAchievedService = require('./medRepTargetAchieved.service');
const financialService = require('./financial.service');
const pdfService = require('./pdf.service');
const logger = require('../utils/logger');

const AMENDABLE_STATUSES = [
  ORDER_STATUS.DELIVERED,
  ORDER_STATUS.PARTIALLY_DELIVERED,
  ORDER_STATUS.PARTIALLY_RETURNED
];

const AFFECTED_MODULES = [
  'inventory',
  'pharmacy_ar',
  'document_open',
  'gl',
  'distributor_clearing',
  'med_rep_targets',
  'doctor_activity',
  'transaction_pnl'
];

const resolveAmendmentType = (raw) => {
  const t = raw || AMENDMENT_TYPE.QUANTITY_REDUCTION;
  if (t !== AMENDMENT_TYPE.QUANTITY_REDUCTION) {
    throw new ApiError(400, `Unsupported amendmentType: ${t}. v1 supports QUANTITY_REDUCTION only.`);
  }
  return t;
};

const resolveSource = (raw) => {
  const s = raw || AMENDMENT_SOURCE.DELIVERED_ORDER_CORRECTION;
  if (!Object.values(AMENDMENT_SOURCE).includes(s)) {
    throw new ApiError(400, `Unsupported amendment source: ${s}`);
  }
  return s;
};

const buildLinePlan = async (session, companyId, order, itemsPayload) => {
  const linePlans = [];
  let totalAmount = 0;
  let totalCost = 0;
  let totalPacks = 0;
  let tpDeltaTotal = 0;
  const creditByDelivery = new Map();

  for (const raw of itemsPayload || []) {
    const orderItem = order.items.find((i) => i.productId.toString() === String(raw.productId));
    if (!orderItem) throw new ApiError(400, `Product ${raw.productId} not in this order`);

    const remaining = remainingAmendableQty(orderItem);
    let deltaQty;
    try {
      deltaQty = deltaQtyForNewRemaining(raw.newQuantity, remaining);
    } catch (err) {
      throw new ApiError(400, `${orderItem.productName || raw.productId}: ${err.message}`);
    }

    const previousQty = remaining;
    const newQty = Number(raw.newQuantity);

    const { lastDelivery, dLine } = await qtyCredit.findLatestDeliveryLine(
      session,
      companyId,
      order._id,
      orderItem.productId
    );
    const priorCredits = await qtyCredit.loadPriorQtyCreditsForProduct(
      session,
      companyId,
      order._id,
      orderItem.productId
    );
    for (const planned of linePlans) {
      if (String(planned.productId) !== String(orderItem.productId)) continue;
      priorCredits.push({
        physicalQty: planned.deltaQty,
        paidDelta: planned.paidDelta,
        bonusDelta: planned.bonusDelta
      });
    }
    let snap;
    try {
      snap = qtyCredit.computeQtyCreditAgainstDeliveryLine(dLine, deltaQty, { priorCredits });
    } catch (err) {
      throw new ApiError(400, `${orderItem.productName || raw.productId}: ${err.message}`);
    }
    const tpDelta = roundPKR((orderItem.tpAtTime || 0) * deltaQty);

    linePlans.push({
      productId: orderItem.productId,
      productName: orderItem.productName,
      previousQty,
      newQty,
      deltaQty,
      paidDelta: snap.paidDelta,
      bonusDelta: snap.bonusDelta,
      allocationPolicy: snap.allocationPolicy,
      avgCostAtTime: snap.avgCostAtTime,
      finalSellingPrice: snap.finalSellingPrice,
      lineCreditAmount: snap.creditAmount,
      companyShare: snap.companyShare,
      distributorShare: snap.distributorShare,
      tpDelta,
      deliveryId: lastDelivery?._id || null,
      creditAmount: snap.creditAmount,
      lineCost: snap.lineCost,
      totalProfit: snap.totalProfit
    });

    totalAmount += snap.creditAmount;
    totalCost += snap.lineCost;
    totalPacks += deltaQty;
    tpDeltaTotal += tpDelta;

    if (lastDelivery?._id && snap.creditAmount > 0) {
      const did = String(lastDelivery._id);
      creditByDelivery.set(did, roundPKR((creditByDelivery.get(did) || 0) + snap.creditAmount));
    }
  }

  if (!linePlans.length) throw new ApiError(400, 'At least one line must be amended');

  return {
    linePlans,
    totalAmount: roundPKR(totalAmount),
    totalCost: roundPKR(totalCost),
    totalProfit: roundPKR(totalAmount - totalCost),
    totalPacks,
    tpDeltaTotal: roundPKR(tpDeltaTotal),
    creditByDelivery
  };
};

const preview = async (companyId, orderId, body, reqUser, timeZone = 'UTC', opts = {}) => {
  requireCompanyIanaZone(timeZone);
  const order = await Order.findOne({ _id: orderId, companyId });
  if (!order) throw new ApiError(404, 'Order not found');
  assertOrderVisibleToUser(order, opts.visibleRepIds ?? null);
  if (!AMENDABLE_STATUSES.includes(order.status)) {
    throw new ApiError(400, 'Order cannot be amended in its current status');
  }
  resolveAmendmentType(body.amendmentType);
  resolveSource(body.source);
  if (!body.reason || !String(body.reason).trim()) {
    throw new ApiError(400, 'reason is required');
  }

  const session = null;
  const plan = await buildLinePlan(session, companyId, order, body.items);

  let openBefore = null;
  let openAfter = null;
  let overpaymentCredit = 0;
  try {
    const state = await financialService.computePharmacyReceivableState(companyId, order.pharmacyId);
    openBefore = state.pharmacyOpen ?? state.totalOpen ?? null;
    if (openBefore != null) {
      openAfter = roundPKR(openBefore - plan.totalAmount);
      overpaymentCredit = roundPKR(Math.max(0, -openAfter));
    }
  } catch (err) {
    logger.warn('Amendment preview open state failed', { message: err?.message });
  }

  return {
    orderId: order._id,
    orderNumber: order.orderNumber,
    amendmentType: AMENDMENT_TYPE.QUANTITY_REDUCTION,
    source: AMENDMENT_SOURCE.DELIVERED_ORDER_CORRECTION,
    reason: String(body.reason).trim(),
    allocationPolicy: qtyCredit.DEFAULT_QTY_CREDIT_ALLOCATION_POLICY,
    items: plan.linePlans.map((l) => ({
      productId: l.productId,
      productName: l.productName,
      previousQty: l.previousQty,
      newQty: l.newQty,
      deltaQty: l.deltaQty,
      paidDelta: l.paidDelta,
      bonusDelta: l.bonusDelta,
      allocationPolicy: l.allocationPolicy,
      lineCreditAmount: l.lineCreditAmount,
      tpDelta: l.tpDelta
    })),
    impact: {
      inventoryRestockPacks: plan.totalPacks,
      salesPacksDelta: -plan.totalPacks,
      salesTpDelta: -plan.tpDeltaTotal,
      invoiceCreditAmount: plan.totalAmount,
      paidPacksReversed: plan.linePlans.reduce((s, l) => s + (l.paidDelta || 0), 0),
      bonusPacksReversed: plan.linePlans.reduce((s, l) => s + (l.bonusDelta || 0), 0),
      openArBefore: openBefore,
      openArAfter: openAfter,
      overpaymentCredit,
      warning:
        overpaymentCredit > 0
          ? 'Amendment credit exceeds open receivable; pharmacy will hold a credit balance. Collections are not auto-reversed.'
          : null
    }
  };
};

const create = async (companyId, orderId, body, reqUser, timeZone = 'UTC', opts = {}) => {
  const tz = requireCompanyIanaZone(timeZone);
  resolveAmendmentType(body.amendmentType);
  const source = resolveSource(body.source);
  if (!body.reason || !String(body.reason).trim()) {
    throw new ApiError(400, 'reason is required');
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findOne({ _id: orderId, companyId }).session(session);
    if (!order) throw new ApiError(404, 'Order not found');
    assertOrderVisibleToUser(order, opts.visibleRepIds ?? null);
    if (!AMENDABLE_STATUSES.includes(order.status)) {
      throw new ApiError(400, 'Order cannot be amended in its current status');
    }

    const plan = await buildLinePlan(session, companyId, order, body.items);

    for (const line of plan.linePlans) {
      await qtyCredit.restockDistributorQty(session, {
        companyId,
        distributorId: order.distributorId,
        productId: line.productId,
        quantity: line.deltaQty
      });
      const orderItem = order.items.find((i) => i.productId.toString() === String(line.productId));
      orderItem.amendedQty = (orderItem.amendedQty || 0) + line.deltaQty;
    }

    order.updatedBy = reqUser.userId;
    await order.save({ session });

    const amendedAt = utcNow();
    const version =
      (await OrderAmendment.countDocuments({ companyId, orderId, isDeleted: { $ne: true } }).session(
        session
      )) + 1;
    const amendmentNumber = await getNextSequenceNumber(companyId, 'AMD', { session });
    const goodsCreditByDelivery = new Map(plan.creditByDelivery);
    const taxExpand = await qtyCredit.applyTaxToCreditByDelivery(
      session,
      companyId,
      plan.creditByDelivery
    );
    const allocations = qtyCredit.buildCreditAllocationsFromMap(plan.creditByDelivery);

    const deliveryIds = [...new Set(plan.linePlans.map((l) => l.deliveryId).filter(Boolean))];
    const invoiceNumbers = [];
    if (deliveryIds.length) {
      const dels = await DeliveryRecord.find({ _id: { $in: deliveryIds } })
        .select('invoiceNumber')
        .session(session)
        .lean();
      for (const d of dels) {
        if (d.invoiceNumber) invoiceNumbers.push(d.invoiceNumber);
      }
    }

    const [amendment] = await OrderAmendment.create(
      [
        {
          companyId,
          orderId,
          amendmentNumber,
          version,
          amendmentType: AMENDMENT_TYPE.QUANTITY_REDUCTION,
          source,
          status: AMENDMENT_STATUS.APPLIED,
          reason: String(body.reason).trim(),
          items: plan.linePlans.map((l) => ({
            productId: l.productId,
            productName: l.productName,
            previousQty: l.previousQty,
            newQty: l.newQty,
            deltaQty: l.deltaQty,
            paidDelta: l.paidDelta,
            bonusDelta: l.bonusDelta,
            allocationPolicy: l.allocationPolicy,
            avgCostAtTime: l.avgCostAtTime,
            finalSellingPrice: l.finalSellingPrice,
            lineCreditAmount: l.lineCreditAmount,
            companyShare: l.companyShare,
            distributorShare: l.distributorShare,
            tpDelta: l.tpDelta,
            deliveryId: l.deliveryId
          })),
          allocations,
          totalAmount: plan.totalAmount,
          totalCost: plan.totalCost,
          totalProfit: plan.totalProfit,
          tpDeltaTotal: plan.tpDeltaTotal,
          affectedModules: AFFECTED_MODULES,
          orderNumber: order.orderNumber,
          pharmacyId: order.pharmacyId,
          distributorId: order.distributorId,
          invoiceNumbers,
          deliveryIds,
          amendedBy: reqUser.userId,
          amendedAt
        }
      ],
      { session, ordered: true }
    );

    await qtyCredit.applyDoctorTpCredit(session, companyId, {
      doctorId: order.doctorId,
      tpAmount: plan.tpDeltaTotal,
      at: amendedAt
    });

    const month = getBusinessMonthKey(amendedAt, tz);

    const arCredit = taxExpand.grandTotal;
    let ledgerEntry = null;
    if (arCredit > 0) {
      ledgerEntry = await qtyCredit.postPharmacyDocumentCredit(session, {
        companyId,
        pharmacyId: order.pharmacyId,
        amount: arCredit,
        referenceType: LEDGER_REFERENCE_TYPE.AMENDMENT,
        referenceId: amendment._id,
        description: `Amendment ${amendmentNumber} for order ${order.orderNumber}`,
        date: amendedAt,
        meta: qtyCredit.buildPharmacyCreditMeta(order._id, plan.creditByDelivery)
      });

      await qtyCredit.postSalesCreditGl(
        session,
        companyId,
        {
          pharmacyId: order.pharmacyId,
          sourceRefId: amendment._id,
          amount: arCredit,
          goodsAmount: taxExpand.goodsTotal,
          taxLineCredits: taxExpand.taxLineCredits,
          date: amendedAt,
          narration: `Amendment ${amendmentNumber} for order ${order.orderNumber}`,
          ledgerEntryId: ledgerEntry?._id
        },
        reqUser
      );
    }

    if (taxExpand.taxTotal > 0) {
      const taxPosting = require('./tax/taxPosting.service');
      await taxPosting.reverseInvoiceTax({
        session,
        companyId,
        pharmacyId: order.pharmacyId,
        businessDate: amendedAt,
        referenceType: 'AMENDMENT',
        referenceId: amendment._id,
        goodsCreditByDelivery
      });
    }

    if (plan.totalAmount > 0) {
      await qtyCredit.postQtyCreditClearingForLines(session, {
        companyId,
        distributorId: order.distributorId,
        orderId: order._id,
        lines: plan.linePlans.map((l) => ({
          productId: l.productId,
          quantity: l.deltaQty,
          finalSellingPrice: l.finalSellingPrice,
          creditAmount: l.lineCreditAmount
        })),
        documentId: amendment._id,
        date: amendedAt,
        clearingReferenceType: LEDGER_REFERENCE_TYPE.AMENDMENT_CLEARING_ADJ
      });
    }

    await qtyCredit.postQtyCreditTransaction(session, {
      companyId,
      type: TRANSACTION_TYPE.AMENDMENT,
      referenceType: 'AMENDMENT',
      referenceId: amendment._id,
      totalAmount: plan.totalAmount,
      totalCost: plan.totalCost,
      totalProfit: plan.totalProfit,
      date: amendedAt,
      description: `Amendment - ${amendmentNumber}`
    });

    await auditService.logInSession(session, {
      companyId,
      userId: reqUser.userId,
      action: 'order.amend',
      entityType: 'Order',
      entityId: orderId,
      changes: {
        amendmentId: amendment._id,
        amendmentNumber,
        version,
        items: plan.linePlans
      }
    });

    const creditNote = await creditNoteService.createForAmendmentInSession(session, {
      companyId,
      orderId,
      amendment,
      reqUser,
      issuedAt: amendedAt
    });

    await auditService.logInSession(session, {
      companyId,
      userId: reqUser.userId,
      action: 'creditNote.issue',
      entityType: 'CreditNote',
      entityId: creditNote._id,
      changes: {
        creditNoteNumber: creditNote.creditNoteNumber,
        amendmentId: amendment._id,
        amendmentNumber
      }
    });

    await session.commitTransaction();

    try {
      await medRepTargetAchievedService.syncAchievedForRepMonth(
        companyId,
        order.medicalRepId,
        month,
        tz
      );
    } catch (err) {
      logger.error('MedRepTarget achieved sync failed after amendment', {
        orderId: String(orderId),
        month,
        message: err?.message,
        stack: err?.stack
      });
    }

    pdfService.generateCreditNote(creditNote._id).catch((err) => {
      logger.error('Credit note PDF generation failed after amendment', {
        creditNoteId: String(creditNote._id),
        message: err?.message,
        stack: err?.stack
      });
    });

    let overpaymentCredit = 0;
    try {
      const state = await financialService.computePharmacyReceivableState(companyId, order.pharmacyId);
      const open = state.pharmacyOpen ?? state.totalOpen ?? 0;
      overpaymentCredit = roundPKR(Math.max(0, -open));
    } catch {
      /* ignore */
    }

    return {
      amendment: amendment.toObject(),
      creditNote: creditNote.toObject(),
      overpaymentCredit,
      warning:
        overpaymentCredit > 0
          ? 'Amendment credit exceeds open receivable; pharmacy holds a credit balance.'
          : null
    };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const listByOrder = async (companyId, orderId, opts = {}) => {
  const order = await Order.findOne({ _id: orderId, companyId }).select('_id medicalRepId').lean();
  if (!order) throw new ApiError(404, 'Order not found');
  assertOrderVisibleToUser(order, opts.visibleRepIds ?? null);
  return OrderAmendment.find({ companyId, orderId, isDeleted: { $ne: true } })
    .populate('amendedBy', 'name email')
    .sort({ version: 1 })
    .lean();
};

const getById = async (companyId, orderId, amendmentId, opts = {}) => {
  const order = await Order.findOne({ _id: orderId, companyId }).select('_id medicalRepId').lean();
  if (!order) throw new ApiError(404, 'Order not found');
  assertOrderVisibleToUser(order, opts.visibleRepIds ?? null);
  const amd = await OrderAmendment.findOne({
    _id: amendmentId,
    companyId,
    orderId,
    isDeleted: { $ne: true }
  })
    .populate('amendedBy', 'name email')
    .lean();
  if (!amd) throw new ApiError(404, 'Amendment not found');
  return amd;
};

module.exports = {
  preview,
  create,
  listByOrder,
  getById,
  AMENDABLE_STATUSES
};
