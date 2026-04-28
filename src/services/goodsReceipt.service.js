const mongoose = require('mongoose');
const GoodsReceiptNote = require('../models/GoodsReceiptNote');
const GoodsReceiptLine = require('../models/GoodsReceiptLine');
const PurchaseOrder = require('../models/PurchaseOrder');
const PurchaseOrderLine = require('../models/PurchaseOrderLine');
const Distributor = require('../models/Distributor');
const Product = require('../models/Product');
const ApiError = require('../utils/ApiError');
const { roundPKR } = require('../utils/currency');
const { parsePagination } = require('../utils/pagination');
const {
  PURCHASE_ORDER_STATUS,
  GOODS_RECEIPT_NOTE_STATUS
} = require('../constants/enums');
const { getNextSequenceNumber } = require('../utils/orderNumber');
const { mergeIntoDestination } = require('./inventory.service');
const supplierService = require('./supplier.service');
const auditService = require('./audit.service');

const oid = (id) => new mongoose.Types.ObjectId(id);

const poEligibleForReceiving = new Set([
  PURCHASE_ORDER_STATUS.APPROVED,
  PURCHASE_ORDER_STATUS.PARTIALLY_RECEIVED
]);

const resolvePoLine = async (session, companyId, purchaseOrderId, productId, purchaseOrderLineId) => {
  if (purchaseOrderLineId) {
    const l = await PurchaseOrderLine.findOne({
      _id: purchaseOrderLineId,
      purchaseOrderId,
      companyId,
      isDeleted: { $ne: true }
    }).session(session);
    if (!l) throw new ApiError(400, 'Invalid purchase order line');
    if (String(l.productId) !== String(productId)) {
      throw new ApiError(400, 'Product does not match purchase order line');
    }
    return l;
  }
  const matches = await PurchaseOrderLine.find({
    purchaseOrderId,
    companyId,
    productId,
    isDeleted: { $ne: true }
  }).session(session);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new ApiError(400, 'No purchase order line for this product');
  throw new ApiError(400, 'Multiple PO lines for this product — pass purchaseOrderLineId');
};

const recomputePoStatus = async (session, companyId, purchaseOrderId) => {
  const lines = await PurchaseOrderLine.find({
    purchaseOrderId,
    companyId,
    isDeleted: { $ne: true }
  }).session(session);
  if (!lines.length) return;

  const po = await PurchaseOrder.findOne({ _id: purchaseOrderId, companyId }).session(session);
  if (!po) return;

  const allLinesReceived = lines.every((l) => l.receivedQty >= l.orderedQty);
  if (allLinesReceived) {
    po.status = PURCHASE_ORDER_STATUS.CLOSED;
  } else {
    const anyReceived = lines.some((l) => l.receivedQty > 0);
    po.status = anyReceived ? PURCHASE_ORDER_STATUS.PARTIALLY_RECEIVED : PURCHASE_ORDER_STATUS.APPROVED;
  }
  await po.save({ session });
};

const list = async (companyId, query = {}) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId, isDeleted: { $ne: true } };
  if (query.purchaseOrderId) filter.purchaseOrderId = query.purchaseOrderId;
  if (query.supplierId) filter.supplierId = query.supplierId;
  if (query.status) filter.status = query.status;

  const [docs, total] = await Promise.all([
    GoodsReceiptNote.find(filter)
      .populate('supplierId', 'name')
      .populate('purchaseOrderId', 'orderNumber status')
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    GoodsReceiptNote.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const getById = async (companyId, id) => {
  const grn = await GoodsReceiptNote.findOne({ _id: id, companyId, isDeleted: { $ne: true } })
    .populate('supplierId', 'name')
    .populate('purchaseOrderId', 'orderNumber status supplierId')
    .lean();
  if (!grn) throw new ApiError(404, 'Goods receipt not found');

  const lines = await GoodsReceiptLine.find({ grnId: grn._id, companyId, isDeleted: { $ne: true } })
    .populate('productId', 'name composition mrp tp casting')
    .populate('distributorId', 'name')
    .populate('purchaseOrderLineId', 'orderedQty receivedQty')
    .sort({ createdAt: 1 })
    .lean();

  return { ...grn, lines };
};

const create = async (companyId, body, reqUser) => {
  const { purchaseOrderId, receivedAt, notes, lines, totalShippingCost } = body;
  if (!lines || !Array.isArray(lines) || lines.length === 0) {
    throw new ApiError(400, 'At least one receipt line is required');
  }

  const po = await PurchaseOrder.findOne({ _id: purchaseOrderId, companyId, isDeleted: { $ne: true } });
  if (!po) throw new ApiError(404, 'Purchase order not found');
  if (!poEligibleForReceiving.has(po.status)) {
    throw new ApiError(400, 'Purchase order is not available for receiving');
  }

  const receiptNumber = await getNextSequenceNumber(companyId, 'GRN');

  const grn = await GoodsReceiptNote.create({
    companyId,
    purchaseOrderId: po._id,
    supplierId: po.supplierId,
    receiptNumber,
    receivedAt: receivedAt ? new Date(receivedAt) : new Date(),
    status: GOODS_RECEIPT_NOTE_STATUS.DRAFT,
    notes: notes || undefined,
    totalShippingCost: roundPKR(Number(totalShippingCost) || 0),
    createdBy: reqUser.userId
  });

  const lineRows = [];
  for (const l of lines) {
    const landed = roundPKR(l.unitCost);
    const qty = Number(l.qtyReceived);
    if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, 'qtyReceived must be positive on each line');
    if (!Number.isFinite(landed) || landed < 0) throw new ApiError(400, 'unitCost must be non-negative');
    if (l.factoryUnitCost !== undefined && l.factoryUnitCost !== null && l.factoryUnitCost !== '') {
      const fac = roundPKR(Number(l.factoryUnitCost));
      if (!Number.isFinite(fac) || fac < 0) throw new ApiError(400, 'factoryUnitCost must be non-negative');
      if (fac > landed + 1e-6) {
        throw new ApiError(400, 'factoryUnitCost cannot exceed landed unitCost on a line');
      }
    }

    const dist = await Distributor.findOne({
      _id: l.distributorId,
      companyId,
      isActive: true,
      isDeleted: { $ne: true }
    });
    if (!dist) throw new ApiError(404, 'Distributor not found or inactive');

    const prod = await Product.findOne({
      _id: l.productId,
      companyId,
      isActive: true,
      isDeleted: { $ne: true }
    });
    if (!prod) throw new ApiError(400, 'Product not found or inactive');

    await resolvePoLine(null, companyId, po._id, l.productId, l.purchaseOrderLineId || null);

    const row = {
      companyId,
      grnId: grn._id,
      purchaseOrderLineId: l.purchaseOrderLineId || null,
      productId: l.productId,
      qtyReceived: qty,
      unitCost: landed,
      distributorId: l.distributorId,
      notes: l.notes || undefined
    };
    if (l.factoryUnitCost !== undefined && l.factoryUnitCost !== null && l.factoryUnitCost !== '') {
      row.factoryUnitCost = roundPKR(Number(l.factoryUnitCost));
    }
    lineRows.push(row);
  }

  await GoodsReceiptLine.insertMany(lineRows, { ordered: false });

  const full = await getById(companyId, grn._id);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'procurement.grn.create',
    entityType: 'GoodsReceiptNote',
    entityId: grn._id,
    changes: { after: full }
  });
  return full;
};

/**
 * Replace draft receipt lines only; does not post inventory until `post`.
 */
const updateById = async (companyId, grnId, body, reqUser) => {
  const cid = oid(companyId);
  const gid = oid(grnId);

  const grn = await GoodsReceiptNote.findOne({ _id: gid, companyId: cid, isDeleted: { $ne: true } });
  if (!grn) throw new ApiError(404, 'Goods receipt not found');
  if (grn.status !== GOODS_RECEIPT_NOTE_STATUS.DRAFT) {
    throw new ApiError(400, 'Only draft goods receipts can be edited');
  }

  const po = await PurchaseOrder.findOne({ _id: grn.purchaseOrderId, companyId: cid, isDeleted: { $ne: true } });
  if (!po) throw new ApiError(404, 'Purchase order not found');
  if (!poEligibleForReceiving.has(po.status)) {
    throw new ApiError(400, 'Purchase order is not available for receiving');
  }

  const { receivedAt, notes, lines, totalShippingCost } = body;
  if (!lines || !Array.isArray(lines) || lines.length === 0) {
    throw new ApiError(400, 'At least one receipt line is required');
  }

  await GoodsReceiptLine.updateMany(
    { grnId: gid, companyId: cid, isDeleted: { $ne: true } },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: oid(reqUser.userId) } }
  );

  if (receivedAt !== undefined) grn.receivedAt = receivedAt ? new Date(receivedAt) : new Date();
  if (notes !== undefined) grn.notes = notes || undefined;
  if (totalShippingCost !== undefined) grn.totalShippingCost = roundPKR(Number(totalShippingCost) || 0);
  await grn.save();

  const lineRows = [];
  for (const l of lines) {
    const landed = roundPKR(l.unitCost);
    const qty = Number(l.qtyReceived);
    if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, 'qtyReceived must be positive on each line');
    if (!Number.isFinite(landed) || landed < 0) throw new ApiError(400, 'unitCost must be non-negative');
    if (l.factoryUnitCost !== undefined && l.factoryUnitCost !== null && l.factoryUnitCost !== '') {
      const fac = roundPKR(Number(l.factoryUnitCost));
      if (!Number.isFinite(fac) || fac < 0) throw new ApiError(400, 'factoryUnitCost must be non-negative');
      if (fac > landed + 1e-6) {
        throw new ApiError(400, 'factoryUnitCost cannot exceed landed unitCost on a line');
      }
    }

    const dist = await Distributor.findOne({
      _id: l.distributorId,
      companyId: cid,
      isActive: true,
      isDeleted: { $ne: true }
    });
    if (!dist) throw new ApiError(404, 'Distributor not found or inactive');

    const prod = await Product.findOne({
      _id: l.productId,
      companyId: cid,
      isActive: true,
      isDeleted: { $ne: true }
    });
    if (!prod) throw new ApiError(400, 'Product not found or inactive');

    await resolvePoLine(null, cid, po._id, l.productId, l.purchaseOrderLineId || null);

    const row = {
      companyId: cid,
      grnId: gid,
      purchaseOrderLineId: l.purchaseOrderLineId || null,
      productId: l.productId,
      qtyReceived: qty,
      unitCost: landed,
      distributorId: l.distributorId,
      notes: l.notes || undefined
    };
    if (l.factoryUnitCost !== undefined && l.factoryUnitCost !== null && l.factoryUnitCost !== '') {
      row.factoryUnitCost = roundPKR(Number(l.factoryUnitCost));
    }
    lineRows.push(row);
  }

  await GoodsReceiptLine.insertMany(lineRows, { ordered: false });

  const full = await getById(companyId, gid);
  await auditService.log({
    companyId: cid,
    userId: reqUser.userId,
    action: 'procurement.grn.update',
    entityType: 'GoodsReceiptNote',
    entityId: gid,
    changes: { after: full }
  });
  return full;
};

const post = async (companyId, grnId, reqUser) => {
  const cid = oid(companyId);
  const gid = oid(grnId);

  const quick = await GoodsReceiptNote.findOne({ _id: gid, companyId: cid, isDeleted: { $ne: true } }).lean();
  if (!quick) throw new ApiError(404, 'Goods receipt not found');
  if (quick.status === GOODS_RECEIPT_NOTE_STATUS.POSTED) {
    return getById(companyId, grnId);
  }
  if (quick.status !== GOODS_RECEIPT_NOTE_STATUS.DRAFT) {
    throw new ApiError(400, 'Only draft goods receipts can be posted');
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const grn = await GoodsReceiptNote.findOne({
      _id: gid,
      companyId: cid,
      status: GOODS_RECEIPT_NOTE_STATUS.DRAFT,
      isDeleted: { $ne: true }
    }).session(session);
    if (!grn) {
      await session.abortTransaction();
      const posted = await GoodsReceiptNote.findOne({
        _id: gid,
        companyId: cid,
        status: GOODS_RECEIPT_NOTE_STATUS.POSTED,
        isDeleted: { $ne: true }
      }).lean();
      if (posted) return getById(companyId, grnId);
      throw new ApiError(400, 'Goods receipt is not in draft status');
    }

    const lines = await GoodsReceiptLine.find({ grnId: gid, companyId: cid, isDeleted: { $ne: true } }).session(
      session
    );
    if (!lines.length) throw new ApiError(400, 'Goods receipt has no lines');

    const po = await PurchaseOrder.findOne({ _id: grn.purchaseOrderId, companyId: cid, isDeleted: { $ne: true } }).session(
      session
    );
    if (!po) throw new ApiError(404, 'Purchase order not found');
    if (!poEligibleForReceiving.has(po.status)) {
      throw new ApiError(400, 'Purchase order is not available for receiving');
    }

    let purchaseTotal = 0;

    for (const line of lines) {
      const pol = await resolvePoLine(
        session,
        cid,
        grn.purchaseOrderId,
        line.productId,
        line.purchaseOrderLineId || null
      );
      const qty = line.qtyReceived;
      if (qty <= 0) throw new ApiError(400, 'Posted lines must have positive qtyReceived');

      const nextReceived = pol.receivedQty + qty;
      if (nextReceived > pol.orderedQty + 1e-9) {
        throw new ApiError(400, 'Receive quantity would exceed ordered quantity for a purchase order line');
      }

      pol.receivedQty = nextReceived;
      await pol.save({ session });

      const landed = roundPKR(Number(line.unitCost));
      const factoryUnit =
        line.factoryUnitCost != null && line.factoryUnitCost !== undefined
          ? roundPKR(Number(line.factoryUnitCost))
          : landed;
      const linePurchaseAmount = roundPKR(qty * factoryUnit);
      purchaseTotal = roundPKR(purchaseTotal + linePurchaseAmount);

      await mergeIntoDestination({
        session,
        companyId: cid,
        distributorId: line.distributorId,
        productId: line.productId,
        quantity: qty,
        newCostPerUnit: landed,
        reqUser
      });
    }

    await supplierService.recordPurchaseFromGrn(
      {
        session,
        companyId: cid,
        supplierId: grn.supplierId,
        grnId: grn._id,
        amount: purchaseTotal,
        notes: `GRN ${grn.receiptNumber}`
      },
      reqUser
    );

    await recomputePoStatus(session, cid, grn.purchaseOrderId);

    grn.status = GOODS_RECEIPT_NOTE_STATUS.POSTED;
    grn.postedAt = new Date();
    await grn.save({ session });

    await session.commitTransaction();

    const full = await getById(companyId, grnId);
    await auditService.log({
      companyId: cid,
      userId: reqUser.userId,
      action: 'procurement.grn.post',
      entityType: 'GoodsReceiptNote',
      entityId: grn._id,
      changes: { after: full }
    });
    return full;
  } catch (error) {
    try {
      await session.abortTransaction();
    } catch (_) {
      /* committed or already aborted */
    }
    throw error;
  } finally {
    session.endSession();
  }
};

module.exports = {
  list,
  getById,
  create,
  updateById,
  post
};
