const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const DeliveryRecord = require('../models/DeliveryRecord');
const ReturnRecord = require('../models/ReturnRecord');
const DistributorInventory = require('../models/DistributorInventory');
const doctorActivityService = require('./doctorActivity.service');
const Ledger = require('../models/Ledger');
const Transaction = require('../models/Transaction');
const Product = require('../models/Product');
const VisitLog = require('../models/VisitLog');
const Distributor = require('../models/Distributor');
const Pharmacy = require('../models/Pharmacy');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { roundPKR } = require('../utils/currency');
const { getNextSequenceNumber } = require('../utils/orderNumber');
const { parsePagination } = require('../utils/pagination');
const { ORDER_STATUS, LEDGER_TYPE, LEDGER_REFERENCE_TYPE, TRANSACTION_TYPE, LEDGER_ENTITY_TYPE } = require('../constants/enums');
const auditService = require('./audit.service');
const medRepTargetAchievedService = require('./medRepTargetAchieved.service');
const pdfService = require('./pdf.service');
const logger = require('../utils/logger');
const financialService = require('./financial.service');
const glBridge = require('./glBridge.service');
const { calculateBonus, normalizeBonusScheme, lineTotalQuantity } = require('../utils/bonus');
const { utcNow, getBusinessMonthKey, requireCompanyIanaZone } = require('../utils/businessTime');
const {
  escapeRegex,
  qScalar,
  applyCreatedAtRangeFromQuery,
  applyCreatedByFromQuery
} = require('../utils/listQuery');
const {
  applyOrderMedicalRepScope,
  assertOrderVisibleToUser
} = require('../utils/orderScope.util');
const { buildSourceDeliverySnapshot } = require('../utils/sourceDeliverySnapshot.util');

const resolveVisitLogRef = async (companyId, visitLogId, { doctorId, medicalRepId }) => {
  if (visitLogId == null || visitLogId === '') return null;
  const v = await VisitLog.findOne({
    _id: visitLogId,
    companyId,
    isDeleted: { $ne: true }
  })
    .select('_id doctorId employeeId')
    .lean();
  if (!v) throw new ApiError(404, 'Visit log not found');
  if (doctorId && v.doctorId && String(v.doctorId) !== String(doctorId)) {
    throw new ApiError(400, 'visitLogId does not match this order’s doctor');
  }
  if (medicalRepId && String(v.employeeId) !== String(medicalRepId)) {
    throw new ApiError(400, 'visitLogId does not match this order’s medical rep');
  }
  return v._id;
};

const paidUnitsInDeliveryBatch = (orderItem, alreadyDelivered, physicalBatchQty) => {
  const paidCap = Number(orderItem.quantity) || 0;
  const paidDeliveredSoFar = Math.min(alreadyDelivered, paidCap);
  return Math.min(physicalBatchQty, Math.max(0, paidCap - paidDeliveredSoFar));
};

const buildLineItemsFromPayload = (data, productMap, pharmacy, distributor) => {
  const scheme = normalizeBonusScheme(pharmacy.bonusScheme);
  return data.items.map((item) => {
    const product = productMap[item.productId];
    const qty = Number(item.quantity);
    if (Number.isNaN(qty) || qty < 0) throw new ApiError(400, 'Invalid quantity');
    if (qty < 1) throw new ApiError(400, 'Paid quantity must be at least 1');
    const autoBonus = calculateBonus(qty, scheme.buyQty, scheme.getQty);
    let bonusQuantity = autoBonus;
    if (item.bonusQuantity !== undefined && item.bonusQuantity !== null && item.bonusQuantity !== '') {
      bonusQuantity = Number(item.bonusQuantity);
      if (Number.isNaN(bonusQuantity) || bonusQuantity < 0) throw new ApiError(400, 'Invalid bonus quantity');
    }
    if (lineTotalQuantity(qty, bonusQuantity) < 1) throw new ApiError(400, 'Invalid line total quantity');
    return {
      productId: item.productId,
      productName: product.name,
      quantity: qty,
      bonusScheme: { buyQty: scheme.buyQty, getQty: scheme.getQty },
      bonusQuantity,
      tpAtTime: product.tp,
      castingAtTime: product.casting,
      distributorDiscount: item.distributorDiscount ?? distributor.discountOnTP ?? 0,
      clinicDiscount: item.clinicDiscount ?? pharmacy.discountOnTP ?? 0
    };
  });
};

const PAYMENT_STATUS = {
  UNPAID: 'UNPAID',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID'
};

const PAYMENT_EPS = 0.001;

/**
 * Derive receivable payment status from invoice total vs remaining open (FIFO open).
 * Returns null when the order has no invoice yet (not delivered).
 */
const deriveOrderPaymentStatus = (invoiceAmount, outstanding) => {
  if (invoiceAmount <= PAYMENT_EPS) return null;
  if (outstanding <= PAYMENT_EPS) return PAYMENT_STATUS.PAID;
  if (outstanding + PAYMENT_EPS >= invoiceAmount) return PAYMENT_STATUS.UNPAID;
  return PAYMENT_STATUS.PARTIALLY_PAID;
};

const pharmacyIdOfOrder = (order) => {
  const p = order.pharmacyId;
  if (!p) return null;
  return String(p._id || p);
};

/**
 * Attach invoiceAmount / outstanding / paymentStatus to a page of orders.
 * Reuses pharmacy FIFO receivable state (same engine as collections) — one call per
 * distinct pharmacy on the page, plus one delivery query for invoice totals.
 */
const enrichOrdersWithPaymentSummary = async (companyId, docs) => {
  if (!docs.length) return [];

  const plain = docs.map((d) => (typeof d.toObject === 'function' ? d.toObject() : { ...d }));
  const orderIdStrs = plain.map((o) => String(o._id));
  const orderIdSet = new Set(orderIdStrs);
  const orderOids = plain.map((o) => o._id);

  const deliveries = await DeliveryRecord.find({
    companyId,
    orderId: { $in: orderOids },
    isDeleted: { $ne: true }
  })
    .select('orderId pharmacyNetPayable totalAmount invoiceGrandTotal taxTotal')
    .lean();

  const { resolveInvoiceGrandTotal } = require('../utils/invoiceTotals');
  const invoiceByOrder = {};
  for (const d of deliveries) {
    const oid = String(d.orderId);
    const amt = resolveInvoiceGrandTotal(d);
    invoiceByOrder[oid] = roundPKR((invoiceByOrder[oid] || 0) + amt);
  }

  const pharmacyIdsNeeded = [
    ...new Set(
      plain
        .filter((o) => (invoiceByOrder[String(o._id)] || 0) > PAYMENT_EPS)
        .map(pharmacyIdOfOrder)
        .filter(Boolean)
    )
  ];

  const outstandingByOrder = {};
  await Promise.all(
    pharmacyIdsNeeded.map(async (pid) => {
      const state = await financialService.computePharmacyReceivableState(companyId, pid);
      for (const row of state.rows) {
        const oid = String(row.orderId);
        if (!orderIdSet.has(oid)) continue;
        outstandingByOrder[oid] = roundPKR(
          (outstandingByOrder[oid] || 0) + Math.max(0, roundPKR(row.open || 0))
        );
      }
    })
  );

  return plain.map((o) => {
    const id = String(o._id);
    const invoiceAmount = roundPKR(invoiceByOrder[id] || 0);
    if (invoiceAmount <= PAYMENT_EPS) {
      return {
        ...o,
        invoiceAmount: null,
        outstanding: null,
        paymentStatus: null
      };
    }

    const rawOpen =
      outstandingByOrder[id] !== undefined ? outstandingByOrder[id] : invoiceAmount;
    const outstanding = roundPKR(Math.min(Math.max(0, rawOpen), invoiceAmount));
    return {
      ...o,
      invoiceAmount,
      outstanding,
      paymentStatus: deriveOrderPaymentStatus(invoiceAmount, outstanding)
    };
  });
};

const list = async (companyId, query, timeZone = 'UTC', opts = {}) => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  const statusParam = qScalar(query.status);
  const statusUpper = statusParam ? String(statusParam).toUpperCase() : '';
  if (statusUpper === 'ALL') {
    /* show every status including CANCELLED */
  } else if (statusUpper === 'RETURNS') {
    /** Partial or full returns (used by financial workspace deep link) */
    filter.status = { $in: [ORDER_STATUS.PARTIALLY_RETURNED, ORDER_STATUS.RETURNED] };
  } else if (statusParam && Object.values(ORDER_STATUS).includes(statusUpper)) {
    filter.status = statusUpper;
  } else {
    /** Default list: hide cancelled orders unless client passes status=CANCELLED or status=ALL */
    filter.status = { $ne: ORDER_STATUS.CANCELLED };
  }
  if (query.distributorId) filter.distributorId = query.distributorId;
  if (query.pharmacyId) filter.pharmacyId = query.pharmacyId;
  applyOrderMedicalRepScope(filter, opts.visibleRepIds ?? null, query.medicalRepId);
  applyCreatedByFromQuery(filter, query);
  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    const or = [{ orderNumber: { $regex: rx, $options: 'i' } }];
    const pharmacies = await Pharmacy.find({
      companyId,
      isActive: true,
      name: { $regex: rx, $options: 'i' }
    })
      .select('_id')
      .lean()
      .limit(100);
    const pids = pharmacies.map((p) => p._id);
    if (pids.length) or.push({ pharmacyId: { $in: pids } });
    filter.$or = or;
  }

  const [docs, total] = await Promise.all([
    Order.find(filter)
      .populate('pharmacyId', 'name city')
      .populate('doctorId', 'name')
      .populate('distributorId', 'name')
      .populate('medicalRepId', 'name')
      .sort(sort).skip(skip).limit(limit),
    Order.countDocuments(filter)
  ]);

  const enriched = await enrichOrdersWithPaymentSummary(companyId, docs);
  return { docs: enriched, total, page, limit };
};

const create = async (companyId, data, reqUser, _timeZone) => {
  let medicalRepId = reqUser.userId;
  if (data.medicalRepId) {
    const rep = await User.findOne({ _id: data.medicalRepId, companyId, isActive: true });
    if (!rep) throw new ApiError(400, 'Selected user is not an active member of this company');
    medicalRepId = data.medicalRepId;
  }

  const orderDate = utcNow();

  const [pharmacy, distributor] = await Promise.all([
    Pharmacy.findOne({ _id: data.pharmacyId, companyId, isActive: true }),
    Distributor.findOne({ _id: data.distributorId, companyId, isActive: true })
  ]);
  if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');
  if (!distributor) throw new ApiError(404, 'Distributor not found');

  const productIds = data.items.map((i) => i.productId);
  const products = await Product.find({ _id: { $in: productIds }, companyId, isActive: true });
  if (products.length !== productIds.length) throw new ApiError(400, 'One or more products not found');

  const productMap = {};
  products.forEach((p) => { productMap[p._id.toString()] = p; });

  const items = buildLineItemsFromPayload(data, productMap, pharmacy, distributor);

  const { items: itemsWithSnap, totals } = financialService.enrichOrderItemsWithFinancialSnapshot(items, distributor);
  const totalOrderedAmount = totals.totalAmount;

  const visitLogOid =
    data.visitLogId != null && String(data.visitLogId).trim() !== ''
      ? await resolveVisitLogRef(companyId, data.visitLogId, {
          doctorId: data.doctorId || null,
          medicalRepId
        })
      : null;

  const createPayload = () => ({
    companyId,
    pharmacyId: data.pharmacyId,
    doctorId: data.doctorId || null,
    distributorId: data.distributorId,
    medicalRepId,
    visitLogId: visitLogOid,
    items: itemsWithSnap,
    totalOrderedAmount,
    totalAmount: totals.totalAmount,
    pharmacyDiscountAmount: totals.pharmacyDiscountAmount,
    amountAfterPharmacyDiscount: totals.amountAfterPharmacyDiscount,
    distributorCommissionAmount: totals.distributorCommissionAmount,
    finalCompanyRevenue: totals.finalCompanyRevenue,
    totalBonusQuantity: totals.totalBonusQuantity,
    totalCastingCost: totals.totalCastingCost,
    orderDate,
    notes: data.notes,
    createdBy: reqUser.userId
  });

  const orderNumber = await getNextSequenceNumber(companyId, 'ORD');
  const order = await Order.create({ ...createPayload(), orderNumber });

  await auditService.log({ companyId, userId: reqUser.userId, action: 'order.create', entityType: 'Order', entityId: order._id, changes: { after: order.toObject() } });

  return order;
};

const getById = async (companyId, id, opts = {}) => {
  const order = await Order.findOne({ _id: id, companyId })
    .populate('pharmacyId', 'name city address phone bonusScheme discountOnTP')
    .populate('doctorId', 'name specialization')
    .populate('distributorId', 'name city discountOnTP commissionPercentOnTP')
    .populate('medicalRepId', 'name employeeCode')
    .populate('visitLogId', 'visitTime doctorId employeeId')
    .populate('items.productId', 'name composition mrp tp casting');
  if (!order) throw new ApiError(404, 'Order not found');
  assertOrderVisibleToUser(order, opts.visibleRepIds ?? null);

  const OrderAmendment = require('../models/OrderAmendment');
  const creditNoteService = require('./creditNote.service');
  const { remainingAmendableQty } = require('../utils/orderQty.util');

  const [deliveries, returns, amendments, creditNoteByAmd] = await Promise.all([
    DeliveryRecord.find({ companyId, orderId: id }).populate('deliveredBy', 'name employeeCode').sort({ deliveredAt: -1 }),
    ReturnRecord.find({ companyId, orderId: id }).populate('returnedBy', 'name').sort({ returnedAt: -1 }),
    OrderAmendment.find({ companyId, orderId: id, isDeleted: { $ne: true } })
      .populate('amendedBy', 'name email')
      .sort({ version: 1 })
      .lean(),
    creditNoteService.mapCreditNotesByAmendmentId(companyId, id)
  ]);

  const obj = order.toObject();
  obj.items = (obj.items || []).map((item) => ({
    ...item,
    remainingAmendableQty: remainingAmendableQty(item),
    remainingReturnableQty: remainingAmendableQty(item)
  }));

  const amendmentsWithCn = (amendments || []).map((a) => ({
    ...a,
    creditNote: creditNoteByAmd[String(a._id)] || null
  }));

  const base = {
    ...obj,
    deliveries,
    returns,
    amendments: amendmentsWithCn,
    creditNotes: Object.values(creditNoteByAmd)
  };

  const [enriched] = await enrichOrdersWithPaymentSummary(companyId, [base]);
  return enriched;
};

const update = async (companyId, id, data, reqUser, opts = {}) => {
  const order = await Order.findOne({ _id: id, companyId });
  if (!order) throw new ApiError(404, 'Order not found');
  assertOrderVisibleToUser(order, opts.visibleRepIds ?? null);
  if (order.status !== ORDER_STATUS.PENDING) throw new ApiError(400, 'Only pending orders can be edited');

  const before = order.toObject();

  if (data.pharmacyId !== undefined) {
    const pharmacy = await Pharmacy.findOne({ _id: data.pharmacyId, companyId, isActive: true });
    if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');
    order.pharmacyId = data.pharmacyId;
  }
  if (data.distributorId !== undefined) {
    const distributor = await Distributor.findOne({ _id: data.distributorId, companyId, isActive: true });
    if (!distributor) throw new ApiError(404, 'Distributor not found');
    order.distributorId = data.distributorId;
  }
  if (data.doctorId !== undefined) {
    order.doctorId = data.doctorId && String(data.doctorId).trim() ? data.doctorId : null;
  }
  if (data.medicalRepId !== undefined) {
    const rep = await User.findOne({ _id: data.medicalRepId, companyId, isActive: true });
    if (!rep) throw new ApiError(400, 'Selected user is not an active member of this company');
    order.medicalRepId = data.medicalRepId;
  }
  if (data.visitLogId !== undefined) {
    const vid = data.visitLogId && String(data.visitLogId).trim() ? data.visitLogId : null;
    order.visitLogId = vid
      ? await resolveVisitLogRef(companyId, vid, {
          doctorId: order.doctorId,
          medicalRepId: order.medicalRepId
        })
      : null;
  }
  if (data.notes !== undefined) order.notes = data.notes;

  if (data.items) {
    const [pharmacy, distributor] = await Promise.all([
      Pharmacy.findOne({ _id: order.pharmacyId, companyId }),
      Distributor.findOne({ _id: order.distributorId, companyId })
    ]);
    const productIds = data.items.map((i) => i.productId);
    const products = await Product.find({ _id: { $in: productIds }, companyId, isActive: true });
    const productMap = {};
    products.forEach((p) => { productMap[p._id.toString()] = p; });

    const rawItems = buildLineItemsFromPayload(data, productMap, pharmacy, distributor).map((row) => ({
      ...row,
      deliveredQty: 0,
      returnedQty: 0
    }));
    const { items: itemsWithSnap, totals } = financialService.enrichOrderItemsWithFinancialSnapshot(rawItems, distributor);
    order.items = itemsWithSnap;
    order.totalOrderedAmount = totals.totalAmount;
    order.totalAmount = totals.totalAmount;
    order.pharmacyDiscountAmount = totals.pharmacyDiscountAmount;
    order.amountAfterPharmacyDiscount = totals.amountAfterPharmacyDiscount;
    order.distributorCommissionAmount = totals.distributorCommissionAmount;
    order.finalCompanyRevenue = totals.finalCompanyRevenue;
    order.totalBonusQuantity = totals.totalBonusQuantity;
    order.totalCastingCost = totals.totalCastingCost;
  }
  order.updatedBy = reqUser.userId;
  await order.save();
  await auditService.log({ companyId, userId: reqUser.userId, action: 'order.update', entityType: 'Order', entityId: order._id, changes: { before, after: order.toObject() } });
  return order;
};

const deliver = async (companyId, orderId, body, reqUser, timeZone = 'UTC', opts = {}) => {
  const tz = requireCompanyIanaZone(timeZone);
  const deliveryItems = body.items;
  const businessDate = utcNow();

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findOne({ _id: orderId, companyId }).session(session);
    if (!order) throw new ApiError(404, 'Order not found');
    assertOrderVisibleToUser(order, opts.visibleRepIds ?? null);
    if (![ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_DELIVERED].includes(order.status)) {
      throw new ApiError(400, 'Order cannot be delivered in its current status');
    }

    const distributor = await Distributor.findOne({ _id: order.distributorId, companyId }).session(session);
    if (!distributor) throw new ApiError(404, 'Distributor not found');

    const deliveryRecordItems = [];
    let totalAmount = 0;
    let totalCost = 0;
    let totalPacks = 0;
    let tpSubtotal = 0;
    let distributorShareTotal = 0;
    let companyShareTotal = 0;
    let commissionPctSnapshot = null;

    for (const dItem of deliveryItems) {
      const orderItem = order.items.find((i) => i.productId.toString() === dItem.productId);
      if (!orderItem) throw new ApiError(400, `Product ${dItem.productId} not in this order`);

      const lineMax = lineTotalQuantity(orderItem.quantity, orderItem.bonusQuantity || 0);
      const alreadyDelivered = orderItem.deliveredQty;
      const remaining = lineMax - alreadyDelivered;
      if (dItem.quantity > remaining) {
        throw new ApiError(400, `Cannot deliver ${dItem.quantity} of ${orderItem.productName}. Remaining: ${remaining}`);
      }

      const inv = await DistributorInventory.findOne({ companyId, distributorId: order.distributorId, productId: dItem.productId }).session(session);
      if (!inv || inv.quantity < dItem.quantity) {
        throw new ApiError(400, `Insufficient inventory for ${orderItem.productName}`);
      }

      const physicalQty = dItem.quantity;
      const paidThisBatch = paidUnitsInDeliveryBatch(orderItem, alreadyDelivered, physicalQty);
      const snap = financialService.computeLineSnapshot(orderItem, paidThisBatch, distributor);
      const grossTpLineTotal = roundPKR((orderItem.tpAtTime || 0) * physicalQty);
      commissionPctSnapshot = snap.commissionPct;

      const avgCostAtTime = inv.avgCostPerUnit;
      const linePharmacyNet = snap.linePharmacyNet;
      const lineCost = roundPKR(avgCostAtTime * physicalQty);
      const totalProfit = roundPKR(linePharmacyNet - lineCost);
      const finalSellingPrice = physicalQty > 0 ? roundPKR(linePharmacyNet / physicalQty) : 0;
      const profitPerUnit = physicalQty > 0 ? roundPKR(totalProfit / physicalQty) : 0;

      await DistributorInventory.updateOne(
        { _id: inv._id },
        { $inc: { quantity: -physicalQty }, $set: { lastUpdated: utcNow() } },
        { session }
      );

      orderItem.deliveredQty += physicalQty;

      deliveryRecordItems.push({
        productId: dItem.productId,
        quantity: physicalQty,
        paidQuantity: paidThisBatch,
        bonusQuantity: physicalQty - paidThisBatch,
        avgCostAtTime,
        finalSellingPrice,
        profitPerUnit,
        totalProfit,
        tpLineTotal: grossTpLineTotal,
        distributorShare: snap.distributorShare,
        linePharmacyNet: snap.linePharmacyNet,
        companyShare: snap.companyShare
      });

      const lineNet = linePharmacyNet;
      totalAmount += lineNet;
      tpSubtotal += grossTpLineTotal;
      distributorShareTotal += snap.distributorShare;
      companyShareTotal += snap.companyShare;
      totalCost += lineCost;
      totalPacks += physicalQty;
    }

    totalAmount = roundPKR(totalAmount);
    tpSubtotal = roundPKR(tpSubtotal);
    distributorShareTotal = roundPKR(distributorShareTotal);
    companyShareTotal = roundPKR(companyShareTotal);

    const totalProfit = roundPKR(totalAmount - totalCost);

    const allDelivered = order.items.every((i) => i.deliveredQty >= lineTotalQuantity(i.quantity, i.bonusQuantity || 0));
    order.status = allDelivered ? ORDER_STATUS.DELIVERED : ORDER_STATUS.PARTIALLY_DELIVERED;
    order.updatedBy = reqUser.userId;
    await order.save({ session });

    const invoiceNumber = await getNextSequenceNumber(companyId, 'INV', { session });

    const pharmacyNetPayable = totalAmount;

    const Pharmacy = require('../models/Pharmacy');
    const taxEngine = require('./tax/taxEngine.service');
    const taxPosting = require('./tax/taxPosting.service');
    const { TAX_POSTING_STATUS } = require('../constants/taxCatalog');

    const pharmacyDoc = await Pharmacy.findOne({
      _id: order.pharmacyId,
      companyId,
      isDeleted: { $ne: true }
    })
      .session(session)
      .lean();

    const taxResult = await taxEngine.calculate({
      companyId,
      businessDate,
      pharmacy: pharmacyDoc,
      amounts: {
        grossAmount: tpSubtotal,
        subtotal: tpSubtotal,
        afterDiscount: pharmacyNetPayable,
        netPayable: pharmacyNetPayable
      },
      session
    });

    const taxSnapshot = taxEngine.toDeliverySnapshot(taxResult);
    const taxTotal = taxResult.enabled ? roundPKR(taxResult.taxTotal) : 0;
    const invoiceGrandTotal = taxResult.enabled
      ? roundPKR(taxResult.invoiceGrandTotal)
      : pharmacyNetPayable;

    const deliveredById = body.deliveredById || order.medicalRepId;
    const deliveryUser = await User.findOne({ _id: deliveredById, companyId, isActive: true }).session(session);
    if (!deliveryUser) {
      throw new ApiError(400, 'Delivery man not found or inactive');
    }

    const [delivery] = await DeliveryRecord.create(
      [
        {
          companyId,
          orderId,
          invoiceNumber,
          items: deliveryRecordItems,
          totalAmount,
          totalCost,
          totalProfit,
          tpSubtotal,
          distributorShareTotal,
          pharmacyNetPayable,
          goodsNetPayable: pharmacyNetPayable,
          taxTotal,
          invoiceGrandTotal,
          taxSnapshot: taxSnapshot || undefined,
          taxPostingStatus: taxSnapshot
            ? TAX_POSTING_STATUS.POSTED
            : TAX_POSTING_STATUS.NOT_APPLICABLE,
          companyShareTotal,
          distributorCommissionPercent: commissionPctSnapshot,
          deliveredBy: deliveryUser._id,
          deliveredAt: businessDate
        }
      ],
      { session, ordered: true }
    );

    if (order.doctorId && tpSubtotal > 0) {
      await doctorActivityService.applyDeliveryTp(session, companyId, {
        doctorId: order.doctorId,
        tpAmount: tpSubtotal,
        deliveredAt: delivery.deliveredAt
      });
    }

    const month = getBusinessMonthKey(businessDate, tz);

    const { entries } = await financialService.postDeliveryLedgers(session, {
      companyId,
      pharmacyId: order.pharmacyId,
      deliveryId: delivery._id,
      orderId: order._id,
      invoiceNumber,
      pharmacyNetPayable,
      invoiceGrandTotal,
      date: businessDate
    });

    const voucher = await glBridge.postDeliveryGl(
      session,
      companyId,
      {
        pharmacyId: order.pharmacyId,
        deliveryId: delivery._id,
        invoiceNumber,
        pharmacyNetPayable,
        goodsNetPayable: pharmacyNetPayable,
        invoiceGrandTotal,
        taxSnapshot,
        cogsAmount: totalCost,
        date: businessDate,
        ledgerEntryId: entries?.[0]?._id
      },
      reqUser
    );

    if (taxSnapshot) {
      await taxPosting.postInvoiceTax({
        session,
        companyId,
        delivery,
        pharmacyId: order.pharmacyId,
        orderId: order._id,
        voucherId: voucher?._id || null
      });
    }

    await Transaction.create(
      [{ companyId, type: TRANSACTION_TYPE.SALE, referenceType: 'DELIVERY', referenceId: delivery._id, revenue: totalAmount, cost: totalCost, profit: totalProfit, date: businessDate, description: `Sale - ${invoiceNumber}` }],
      { session, ordered: true }
    );

    await auditService.logInSession(session, { companyId, userId: reqUser.userId, action: 'order.deliver', entityType: 'Order', entityId: orderId, changes: { deliveryId: delivery._id, items: deliveryRecordItems } });

    await session.commitTransaction();

    try {
      await medRepTargetAchievedService.syncAchievedForRepMonth(
        companyId,
        order.medicalRepId,
        month,
        tz
      );
    } catch (err) {
      logger.error('MedRepTarget achieved sync failed after delivery', {
        orderId: String(orderId),
        month,
        message: err?.message,
        stack: err?.stack
      });
    }

    // Generate PDF async (non-blocking)
    pdfService.generateInvoice(delivery._id).catch((err) => {
      logger.error('Invoice PDF generation failed after delivery', {
        deliveryId: String(delivery._id),
        message: err?.message,
        stack: err?.stack
      });
    });

    void notifyOrderStatus(companyId, order, 'delivered').catch(() => null);

    return delivery;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const returnOrder = async (companyId, orderId, returnItems, reqUser, timeZone = 'UTC', opts = {}) => {
  const tz = requireCompanyIanaZone(timeZone);
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findOne({ _id: orderId, companyId }).session(session);
    if (!order) throw new ApiError(404, 'Order not found');
    assertOrderVisibleToUser(order, opts.visibleRepIds ?? null);
    if (![ORDER_STATUS.DELIVERED, ORDER_STATUS.PARTIALLY_DELIVERED, ORDER_STATUS.PARTIALLY_RETURNED].includes(order.status)) {
      throw new ApiError(400, 'Order cannot be returned in its current status');
    }

    const qtyCredit = require('./deliveryQtyCredit.service');
    const { remainingReturnableQty } = require('../utils/orderQty.util');

    const returnRecordItems = [];
    let totalAmount = 0;
    let totalCost = 0;
    let totalPacks = 0;
    let tpReturnTotal = 0;
    const creditByDelivery = new Map();

    for (const rItem of returnItems) {
      const orderItem = order.items.find((i) => i.productId.toString() === rItem.productId);
      if (!orderItem) throw new ApiError(400, `Product ${rItem.productId} not in this order`);

      const returnable = remainingReturnableQty(orderItem);
      if (rItem.quantity > returnable) {
        throw new ApiError(400, `Cannot return ${rItem.quantity} of ${orderItem.productName}. Returnable: ${returnable}`);
      }

      const { lastDelivery, dLine } = await qtyCredit.findLatestDeliveryLine(
        session,
        companyId,
        orderId,
        rItem.productId
      );
      const priorCredits = await qtyCredit.loadPriorQtyCreditsForProduct(
        session,
        companyId,
        orderId,
        rItem.productId
      );
      // Same-request returns on one product: include lines already planned in this loop.
      for (const planned of returnRecordItems) {
        if (String(planned.productId) !== String(rItem.productId)) continue;
        priorCredits.push({
          physicalQty: planned.quantity,
          paidDelta: planned.paidDelta,
          bonusDelta: planned.bonusDelta
        });
      }
      let snap;
      try {
        snap = qtyCredit.computeQtyCreditAgainstDeliveryLine(dLine, rItem.quantity, {
          priorCredits
        });
      } catch (err) {
        throw new ApiError(400, `${orderItem.productName || rItem.productId}: ${err.message}`);
      }

      await qtyCredit.restockDistributorQty(session, {
        companyId,
        distributorId: order.distributorId,
        productId: rItem.productId,
        quantity: rItem.quantity
      });

      orderItem.returnedQty += rItem.quantity;

      const lineTp = roundPKR((orderItem.tpAtTime || 0) * rItem.quantity);
      const sourceSnap = buildSourceDeliverySnapshot(lastDelivery, tz);

      returnRecordItems.push({
        productId: rItem.productId,
        quantity: rItem.quantity,
        paidDelta: snap.paidDelta,
        bonusDelta: snap.bonusDelta,
        allocationPolicy: snap.allocationPolicy,
        avgCostAtTime: snap.avgCostAtTime,
        finalSellingPrice: snap.finalSellingPrice,
        lineCreditAmount: snap.creditAmount,
        companyShare: snap.companyShare,
        distributorShare: snap.distributorShare,
        profitPerUnit: snap.profitPerUnit,
        totalProfit: snap.totalProfit,
        reason: rItem.reason || '',
        creditAmount: snap.creditAmount,
        tpAmount: lineTp,
        ...sourceSnap
      });
      totalAmount += snap.creditAmount;
      totalCost += snap.lineCost;
      totalPacks += rItem.quantity;
      tpReturnTotal += lineTp;

      if (lastDelivery?._id && snap.creditAmount > 0) {
        const did = String(lastDelivery._id);
        creditByDelivery.set(did, roundPKR((creditByDelivery.get(did) || 0) + snap.creditAmount));
      }
    }

    tpReturnTotal = roundPKR(tpReturnTotal);
    totalAmount = roundPKR(totalAmount);
    totalCost = roundPKR(totalCost);
    const totalProfit = roundPKR(totalAmount - totalCost);

    const fullyReturnedByReturnQty = order.items.every((i) => (i.returnedQty || 0) >= (i.deliveredQty || 0));
    if (fullyReturnedByReturnQty) {
      order.status = ORDER_STATUS.RETURNED;
    } else {
      const anyReturned = order.items.some((i) => i.returnedQty > 0);
      order.status = anyReturned ? ORDER_STATUS.PARTIALLY_RETURNED : order.status;
    }
    order.updatedBy = reqUser.userId;
    await order.save({ session });

    const retDate = utcNow();
    const goodsCreditByDelivery = new Map(creditByDelivery);
    const taxExpand = await qtyCredit.applyTaxToCreditByDelivery(session, companyId, creditByDelivery);
    const returnAllocations = qtyCredit.buildCreditAllocationsFromMap(creditByDelivery);
    const [returnRecord] = await ReturnRecord.create(
      [
        {
          companyId,
          orderId,
          items: returnRecordItems.map(
            ({ creditAmount: _creditAmount, ...rest }) => rest
          ),
          totalAmount,
          totalCost,
          totalProfit,
          allocations: returnAllocations,
          returnedBy: reqUser.userId,
          returnedAt: retDate
        }
      ],
      { session, ordered: true }
    );

    await qtyCredit.applyDoctorTpCredit(session, companyId, {
      doctorId: order.doctorId,
      tpAmount: tpReturnTotal,
      at: returnRecord.returnedAt
    });

    const arCredit = taxExpand.grandTotal;
    let returnLedger = null;
    if (arCredit > 0) {
      returnLedger = await qtyCredit.postPharmacyDocumentCredit(session, {
        companyId,
        pharmacyId: order.pharmacyId,
        amount: arCredit,
        referenceType: LEDGER_REFERENCE_TYPE.RETURN,
        referenceId: returnRecord._id,
        description: `Return for order ${order.orderNumber}`,
        date: retDate,
        meta: qtyCredit.buildPharmacyCreditMeta(order._id, creditByDelivery)
      });

      await qtyCredit.postSalesCreditGl(
        session,
        companyId,
        {
          pharmacyId: order.pharmacyId,
          sourceRefId: returnRecord._id,
          amount: arCredit,
          goodsAmount: taxExpand.goodsTotal,
          taxLineCredits: taxExpand.taxLineCredits,
          date: retDate,
          narration: `Return for order ${order.orderNumber}`,
          ledgerEntryId: returnLedger?._id
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
        businessDate: retDate,
        referenceType: 'RETURN',
        referenceId: returnRecord._id,
        goodsCreditByDelivery
      });
    }

    if (totalAmount > 0) {
      await qtyCredit.postQtyCreditClearingForLines(session, {
        companyId,
        distributorId: order.distributorId,
        orderId: order._id,
        lines: returnRecordItems.map((row) => ({
          productId: row.productId,
          quantity: row.quantity,
          finalSellingPrice: row.finalSellingPrice,
          creditAmount: row.creditAmount
        })),
        documentId: returnRecord._id,
        date: retDate,
        clearingReferenceType: LEDGER_REFERENCE_TYPE.RETURN_CLEARING_ADJ
      });
    }

    await qtyCredit.postQtyCreditTransaction(session, {
      companyId,
      type: TRANSACTION_TYPE.RETURN,
      referenceType: 'RETURN',
      referenceId: returnRecord._id,
      totalAmount,
      totalCost,
      totalProfit,
      date: retDate,
      description: `Return - ${order.orderNumber}`
    });

    await auditService.logInSession(session, {
      companyId,
      userId: reqUser.userId,
      action: 'order.return',
      entityType: 'Order',
      entityId: orderId,
      changes: { returnId: returnRecord._id, items: returnRecordItems }
    });

    await session.commitTransaction();

    const monthKeys = new Set([getBusinessMonthKey(retDate, tz)]);
    if (order.status === ORDER_STATUS.RETURNED) {
      const dels = await DeliveryRecord.find({
        companyId,
        orderId,
        isDeleted: { $ne: true }
      })
        .select('deliveredAt')
        .lean();
      for (const d of dels) {
        monthKeys.add(getBusinessMonthKey(d.deliveredAt, tz));
      }
    }
    for (const m of monthKeys) {
      try {
        await medRepTargetAchievedService.syncAchievedForRepMonth(
          companyId,
          order.medicalRepId,
          m,
          tz
        );
      } catch (err) {
        logger.error('MedRepTarget achieved sync failed after return', {
          orderId: String(orderId),
          month: m,
          message: err?.message,
          stack: err?.stack
        });
      }
    }

    return returnRecord;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const cancel = async (companyId, id, reqUser, opts = {}) => {
  const order = await Order.findOne({ _id: id, companyId });
  if (!order) throw new ApiError(404, 'Order not found');
  assertOrderVisibleToUser(order, opts.visibleRepIds ?? null);
  if (order.status !== ORDER_STATUS.PENDING) throw new ApiError(400, 'Only pending orders can be cancelled');
  order.status = ORDER_STATUS.CANCELLED;
  order.updatedBy = reqUser.userId;
  await order.save();
  await auditService.log({ companyId, userId: reqUser.userId, action: 'order.cancel', entityType: 'Order', entityId: order._id, changes: { after: { status: 'CANCELLED' } } });
  void notifyOrderStatus(companyId, order, 'cancelled').catch(() => null);
  return order;
};

const { publishEventSafe } = require('./notificationPublisher.service');
const orderNotifyTemplates = require('./notificationTemplates');

async function notifyOrderStatus(companyId, order, outcome) {
  if (!order?.medicalRepId) return;
  const orderId = String(order._id);
  const label = order.orderNumber ? `Order ${order.orderNumber}` : 'Your order';
  const copy =
    outcome === 'delivered'
      ? orderNotifyTemplates.orderDelivered({ label })
      : orderNotifyTemplates.orderCancelled({ label });
  await publishEventSafe({
    eventName: outcome === 'delivered' ? 'order.delivered' : 'order.cancelled',
    companyId,
    userId: order.medicalRepId,
    title: copy.title,
    body: copy.body,
    link: `/order/${orderId}`,
    meta: { orderId },
    dedupeKey: `order:${orderId}:${outcome}`
  });
}

const ensureDeliveryInvoicePdfPath = async (companyId, orderId, deliveryId, opts = {}) => {
  const order = await Order.findOne({ _id: orderId, companyId }).select('medicalRepId');
  if (!order) throw new ApiError(404, 'Order not found');
  assertOrderVisibleToUser(order, opts.visibleRepIds ?? null);

  const delivery = await DeliveryRecord.findOne({
    _id: deliveryId,
    companyId,
    orderId
  }).select('invoiceNumber');
  if (!delivery) throw new ApiError(404, 'Delivery not found');
  if (!delivery.invoiceNumber) throw new ApiError(400, 'Delivery has no invoice number');
  try {
    await pdfService.generateInvoice(deliveryId);
  } catch (err) {
    logger.error('Invoice PDF generation failed on demand', {
      deliveryId: String(deliveryId),
      message: err?.message,
      stack: err?.stack
    });
    throw new ApiError(500, err?.message || 'Invoice PDF could not be generated');
  }
  const absPath = path.resolve(pdfService.invoicePdfPath(delivery.invoiceNumber));
  if (!fs.existsSync(absPath)) throw new ApiError(500, 'Invoice PDF file missing after generation');
  return absPath;
};

/** Order Receipt (Sales Order) PDF — available as soon as the order exists. */
const ensureOrderReceiptPdfPath = async (companyId, orderId, opts = {}) => {
  const order = await Order.findOne({ _id: orderId, companyId }).select('medicalRepId orderNumber');
  if (!order) throw new ApiError(404, 'Order not found');
  assertOrderVisibleToUser(order, opts.visibleRepIds ?? null);

  try {
    await pdfService.generateOrderReceipt(orderId);
  } catch (err) {
    logger.error('Order receipt PDF generation failed on demand', {
      orderId: String(orderId),
      message: err?.message,
      stack: err?.stack
    });
    throw new ApiError(500, err?.message || 'Order receipt PDF could not be generated');
  }
  const token = order.orderNumber || String(order._id);
  const absPath = path.resolve(pdfService.orderReceiptPdfPath(token));
  if (!fs.existsSync(absPath)) throw new ApiError(500, 'Order receipt PDF file missing after generation');
  return absPath;
};

module.exports = {
  list,
  create,
  getById,
  update,
  deliver,
  returnOrder,
  cancel,
  ensureDeliveryInvoicePdfPath,
  ensureOrderReceiptPdfPath
};
