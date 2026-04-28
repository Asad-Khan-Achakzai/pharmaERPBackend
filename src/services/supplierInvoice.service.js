const mongoose = require('mongoose');
const SupplierInvoice = require('../models/SupplierInvoice');
const Supplier = require('../models/Supplier');
const GoodsReceiptNote = require('../models/GoodsReceiptNote');
const PurchaseOrder = require('../models/PurchaseOrder');
const SupplierLedger = require('../models/SupplierLedger');
const ApiError = require('../utils/ApiError');
const { roundPKR } = require('../utils/currency');
const { parsePagination } = require('../utils/pagination');
const {
  SUPPLIER_INVOICE_STATUS,
  GOODS_RECEIPT_NOTE_STATUS,
  SUPPLIER_LEDGER_TYPE,
  SUPPLIER_LEDGER_REFERENCE_TYPE,
  SUPPLIER_LEDGER_ADJUSTMENT_EFFECT
} = require('../constants/enums');
const { getNextSequenceNumber } = require('../utils/orderNumber');
const auditService = require('./audit.service');

const oid = (id) => new mongoose.Types.ObjectId(id);

const computeTotal = (body) => {
  const sub = roundPKR(body.subTotalAmount ?? 0);
  const tax = roundPKR(body.taxAmount ?? 0);
  const freight = roundPKR(body.freightAmount ?? 0);
  const discount = roundPKR(body.discountAmount ?? 0);
  return roundPKR(sub + tax + freight - discount);
};

const validateGrnsForDraft = async (companyId, supplierId, grnIds) => {
  if (!grnIds || !grnIds.length) return;
  const grns = await GoodsReceiptNote.find({
    _id: { $in: grnIds },
    companyId,
    isDeleted: { $ne: true }
  }).lean();

  if (grns.length !== grnIds.length) throw new ApiError(400, 'One or more GRNs not found');
  for (const g of grns) {
    if (String(g.supplierId) !== String(supplierId)) throw new ApiError(400, 'GRN supplier must match invoice supplier');
    if (g.status !== GOODS_RECEIPT_NOTE_STATUS.POSTED) {
      throw new ApiError(400, 'Only posted goods receipts can be linked to an invoice');
    }
  }
};

const sumGrnPurchasesFromLedger = async (companyId, supplierId, grnIds) => {
  if (!grnIds?.length) return 0;
  const rows = await SupplierLedger.find({
    companyId: oid(companyId),
    supplierId: oid(supplierId),
    type: SUPPLIER_LEDGER_TYPE.PURCHASE,
    referenceType: SUPPLIER_LEDGER_REFERENCE_TYPE.GOODS_RECEIPT_NOTE,
    referenceId: { $in: grnIds.map((id) => oid(id)) },
    isDeleted: { $ne: true }
  })
    .select('amount referenceId')
    .lean();

  const byGrn = new Map();
  for (const r of rows) {
    const key = String(r.referenceId);
    byGrn.set(key, (byGrn.get(key) || 0) + (r.amount || 0));
  }
  return roundPKR([...byGrn.values()].reduce((a, b) => a + b, 0));
};

const list = async (companyId, query = {}) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId, isDeleted: { $ne: true } };
  if (query.supplierId) filter.supplierId = query.supplierId;
  if (query.status) filter.status = query.status;

  const [docs, total] = await Promise.all([
    SupplierInvoice.find(filter)
      .populate('supplierId', 'name')
      .populate('purchaseOrderId', 'orderNumber')
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    SupplierInvoice.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const getById = async (companyId, id) => {
  const inv = await SupplierInvoice.findOne({ _id: id, companyId, isDeleted: { $ne: true } })
    .populate('supplierId', 'name')
    .populate('purchaseOrderId', 'orderNumber status')
    .populate('grnIds', 'receiptNumber status purchaseOrderId')
    .lean();
  if (!inv) throw new ApiError(404, 'Supplier invoice not found');
  return inv;
};

const create = async (companyId, body, reqUser) => {
  const supplier = await Supplier.findOne({ _id: body.supplierId, companyId, isDeleted: { $ne: true } });
  if (!supplier) throw new ApiError(404, 'Supplier not found');

  if (body.purchaseOrderId) {
    const po = await PurchaseOrder.findOne({
      _id: body.purchaseOrderId,
      companyId,
      isDeleted: { $ne: true }
    });
    if (!po) throw new ApiError(404, 'Purchase order not found');
    if (String(po.supplierId) !== String(body.supplierId)) {
      throw new ApiError(400, 'Purchase order supplier must match invoice supplier');
    }
  }

  const grnIds = (body.grnIds || []).filter(Boolean);
  await validateGrnsForDraft(companyId, body.supplierId, grnIds);

  const invoiceNumber = body.invoiceNumber?.trim()
    ? body.invoiceNumber.trim()
    : await getNextSequenceNumber(companyId, 'SINV');

  const totalAmount = body.totalAmount != null ? roundPKR(body.totalAmount) : computeTotal(body);
  if (totalAmount < 0) throw new ApiError(400, 'totalAmount must be non-negative');

  const row = await SupplierInvoice.create({
    companyId,
    supplierId: body.supplierId,
    purchaseOrderId: body.purchaseOrderId || null,
    grnIds,
    invoiceNumber,
    invoiceDate: body.invoiceDate ? new Date(body.invoiceDate) : new Date(),
    taxAmount: roundPKR(body.taxAmount ?? 0),
    discountAmount: roundPKR(body.discountAmount ?? 0),
    freightAmount: roundPKR(body.freightAmount ?? 0),
    subTotalAmount: roundPKR(body.subTotalAmount ?? 0),
    totalAmount,
    status: SUPPLIER_INVOICE_STATUS.DRAFT,
    notes: body.notes || undefined,
    createdBy: reqUser.userId
  });

  const full = await getById(companyId, row._id);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'procurement.invoice.create',
    entityType: 'SupplierInvoice',
    entityId: row._id,
    changes: { after: full }
  });
  return full;
};

const update = async (companyId, id, body, reqUser) => {
  const inv = await SupplierInvoice.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
  if (!inv) throw new ApiError(404, 'Supplier invoice not found');
  if (inv.status !== SUPPLIER_INVOICE_STATUS.DRAFT) {
    throw new ApiError(400, 'Only draft invoices can be edited');
  }

  if (body.supplierId !== undefined && String(body.supplierId) !== String(inv.supplierId)) {
    throw new ApiError(400, 'Cannot change supplier on an existing draft');
  }

  if (body.purchaseOrderId !== undefined) {
    if (!body.purchaseOrderId) {
      inv.purchaseOrderId = null;
    } else {
      const po = await PurchaseOrder.findOne({
        _id: body.purchaseOrderId,
        companyId,
        isDeleted: { $ne: true }
      });
      if (!po) throw new ApiError(404, 'Purchase order not found');
      if (String(po.supplierId) !== String(inv.supplierId)) {
        throw new ApiError(400, 'Purchase order supplier must match invoice supplier');
      }
      inv.purchaseOrderId = body.purchaseOrderId;
    }
  }

  if (body.grnIds !== undefined) {
    const grnIds = (body.grnIds || []).filter(Boolean);
    await validateGrnsForDraft(companyId, inv.supplierId, grnIds);
    inv.grnIds = grnIds;
  }

  if (body.invoiceNumber !== undefined) inv.invoiceNumber = String(body.invoiceNumber).trim();
  if (body.invoiceDate !== undefined) inv.invoiceDate = new Date(body.invoiceDate);
  if (body.taxAmount !== undefined) inv.taxAmount = roundPKR(body.taxAmount);
  if (body.discountAmount !== undefined) inv.discountAmount = roundPKR(body.discountAmount);
  if (body.freightAmount !== undefined) inv.freightAmount = roundPKR(body.freightAmount);
  if (body.subTotalAmount !== undefined) inv.subTotalAmount = roundPKR(body.subTotalAmount);

  const fieldsForTotal = {
    taxAmount: inv.taxAmount,
    discountAmount: inv.discountAmount,
    freightAmount: inv.freightAmount,
    subTotalAmount: inv.subTotalAmount
  };
  if (body.totalAmount !== undefined) inv.totalAmount = roundPKR(body.totalAmount);
  else inv.totalAmount = computeTotal(fieldsForTotal);

  if (inv.totalAmount < 0) throw new ApiError(400, 'totalAmount must be non-negative');
  if (body.notes !== undefined) inv.notes = body.notes;

  await inv.save();

  const full = await getById(companyId, inv._id);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'procurement.invoice.update',
    entityType: 'SupplierInvoice',
    entityId: inv._id,
    changes: { after: full }
  });
  return full;
};

const postInvoice = async (companyId, id, reqUser) => {
  const inv = await SupplierInvoice.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
  if (!inv) throw new ApiError(404, 'Supplier invoice not found');
  if (inv.status === SUPPLIER_INVOICE_STATUS.POSTED) return getById(companyId, id);
  if (inv.status !== SUPPLIER_INVOICE_STATUS.DRAFT) throw new ApiError(400, 'Invoice cannot be posted');

  const existingAdj = await SupplierLedger.findOne({
    companyId: oid(companyId),
    supplierId: inv.supplierId,
    type: SUPPLIER_LEDGER_TYPE.ADJUSTMENT,
    referenceType: SUPPLIER_LEDGER_REFERENCE_TYPE.SUPPLIER_INVOICE,
    referenceId: inv._id,
    isDeleted: { $ne: true }
  }).lean();

  if (existingAdj) {
    inv.status = SUPPLIER_INVOICE_STATUS.POSTED;
    await inv.save();
    return getById(companyId, id);
  }

  await validateGrnsForDraft(companyId, inv.supplierId, inv.grnIds || []);

  const expectedFromGrns = await sumGrnPurchasesFromLedger(companyId, inv.supplierId, inv.grnIds || []);
  const invoiceTotal = roundPKR(inv.totalAmount);
  const delta = roundPKR(invoiceTotal - expectedFromGrns);

  if (Math.abs(delta) < 1e-6) {
    inv.status = SUPPLIER_INVOICE_STATUS.POSTED;
    await inv.save();

    await auditService.log({
      companyId,
      userId: reqUser.userId,
      action: 'procurement.invoice.post',
      entityType: 'SupplierInvoice',
      entityId: inv._id,
      changes: { meta: { expectedFromGrns, invoiceTotal, delta: 0 } }
    });
    return getById(companyId, inv._id);
  }

  const adjEffect =
    delta > 0 ? SUPPLIER_LEDGER_ADJUSTMENT_EFFECT.INCREASE_PAYABLE : SUPPLIER_LEDGER_ADJUSTMENT_EFFECT.DECREASE_PAYABLE;
  const amt = roundPKR(Math.abs(delta));

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await SupplierLedger.create(
      [
        {
          companyId: oid(companyId),
          supplierId: inv.supplierId,
          type: SUPPLIER_LEDGER_TYPE.ADJUSTMENT,
          amount: amt,
          adjustmentEffect: adjEffect,
          referenceType: SUPPLIER_LEDGER_REFERENCE_TYPE.SUPPLIER_INVOICE,
          referenceId: inv._id,
          date: new Date(),
          notes: `Invoice ${inv.invoiceNumber} vs GRN-derived liability (expected ${expectedFromGrns}, invoice ${invoiceTotal})`,
          createdBy: reqUser.userId
        }
      ],
      { session }
    );

    inv.status = SUPPLIER_INVOICE_STATUS.POSTED;
    await inv.save({ session });

    await session.commitTransaction();
  } catch (err) {
    try {
      await session.abortTransaction();
    } catch (_) {
      /* noop */
    }
    throw err;
  } finally {
    session.endSession();
  }

  const full = await getById(companyId, inv._id);

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'procurement.invoice.post',
    entityType: 'SupplierInvoice',
    entityId: inv._id,
    changes: { after: full, meta: { expectedFromGrns, invoiceTotal, delta, adjustmentEffect: adjEffect } }
  });
  return full;
};

module.exports = {
  list,
  getById,
  create,
  update,
  postInvoice
};
