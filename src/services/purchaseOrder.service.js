const mongoose = require('mongoose');
const PurchaseOrder = require('../models/PurchaseOrder');
const PurchaseOrderLine = require('../models/PurchaseOrderLine');
const Supplier = require('../models/Supplier');
const Product = require('../models/Product');
const ApiError = require('../utils/ApiError');
const { roundPKR } = require('../utils/currency');
const { parsePagination } = require('../utils/pagination');
const { PURCHASE_ORDER_STATUS } = require('../constants/enums');
const { getNextSequenceNumber } = require('../utils/orderNumber');
const auditService = require('./audit.service');

const oid = (id) => new mongoose.Types.ObjectId(id);

const assertSupplier = async (companyId, supplierId) => {
  const s = await Supplier.findOne({ _id: supplierId, companyId, isDeleted: { $ne: true } });
  if (!s) throw new ApiError(404, 'Supplier not found');
  return s;
};

const loadProducts = async (companyId, productIds) => {
  const products = await Product.find({
    _id: { $in: productIds },
    companyId,
    isActive: true,
    isDeleted: { $ne: true }
  });
  if (products.length !== productIds.length) {
    throw new ApiError(400, 'One or more products not found or inactive');
  }
  return products;
};

const list = async (companyId, query = {}) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId, isDeleted: { $ne: true } };
  if (query.supplierId) filter.supplierId = query.supplierId;
  if (query.status) filter.status = query.status;

  const [docs, total] = await Promise.all([
    PurchaseOrder.find(filter)
      .populate('supplierId', 'name')
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    PurchaseOrder.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const getById = async (companyId, id) => {
  const po = await PurchaseOrder.findOne({ _id: id, companyId, isDeleted: { $ne: true } })
    .populate('supplierId', 'name')
    .lean();
  if (!po) throw new ApiError(404, 'Purchase order not found');

  const lines = await PurchaseOrderLine.find({
    purchaseOrderId: po._id,
    companyId,
    isDeleted: { $ne: true }
  })
    .populate('productId', 'name composition mrp tp casting')
    .sort({ createdAt: 1 })
    .lean();

  return { ...po, lines };
};

const create = async (companyId, body, reqUser) => {
  const { supplierId, notes, lines } = body;
  if (!lines || !Array.isArray(lines) || lines.length === 0) {
    throw new ApiError(400, 'At least one line is required');
  }

  await assertSupplier(companyId, supplierId);
  const productIds = lines.map((l) => l.productId);
  await loadProducts(companyId, productIds);

  const orderNumber = await getNextSequenceNumber(companyId, 'PO');

  let expectedTotalAmount = 0;
  const lineDocs = [];
  for (const l of lines) {
    const qty = Number(l.orderedQty);
    const unitPrice = roundPKR(l.unitPrice ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, 'orderedQty must be positive on each line');
    expectedTotalAmount = roundPKR(expectedTotalAmount + qty * unitPrice);
    lineDocs.push({
      companyId,
      productId: l.productId,
      orderedQty: qty,
      unitPrice,
      notes: l.notes || undefined,
      receivedQty: 0
    });
  }

  const po = await PurchaseOrder.create({
    companyId,
    supplierId,
    orderNumber,
    status: PURCHASE_ORDER_STATUS.DRAFT,
    expectedTotalAmount,
    notes: notes || undefined,
    createdBy: reqUser.userId
  });

  await PurchaseOrderLine.insertMany(
    lineDocs.map((d) => ({ ...d, purchaseOrderId: po._id })),
    { ordered: false }
  );

  const full = await getById(companyId, po._id);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'procurement.po.create',
    entityType: 'PurchaseOrder',
    entityId: po._id,
    changes: { after: full }
  });
  return full;
};

const updateById = async (companyId, id, body, reqUser) => {
  const po = await PurchaseOrder.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
  if (!po) throw new ApiError(404, 'Purchase order not found');
  if (po.status !== PURCHASE_ORDER_STATUS.DRAFT) {
    throw new ApiError(400, 'Only draft supplier orders can be edited');
  }

  const { supplierId, notes, lines } = body;
  if (!lines || !Array.isArray(lines) || lines.length === 0) {
    throw new ApiError(400, 'At least one line is required');
  }

  await assertSupplier(companyId, supplierId);
  const productIds = lines.map((l) => l.productId);
  await loadProducts(companyId, productIds);

  const cid = oid(companyId);
  const poid = oid(id);

  await PurchaseOrderLine.updateMany(
    { purchaseOrderId: poid, companyId: cid, isDeleted: { $ne: true } },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: oid(reqUser.userId) } }
  );

  let expectedTotalAmount = 0;
  const lineDocs = [];
  for (const l of lines) {
    const qty = Number(l.orderedQty);
    const unitPrice = roundPKR(l.unitPrice ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, 'orderedQty must be positive on each line');
    expectedTotalAmount = roundPKR(expectedTotalAmount + qty * unitPrice);
    lineDocs.push({
      companyId: cid,
      productId: l.productId,
      orderedQty: qty,
      unitPrice,
      notes: l.notes || undefined,
      receivedQty: 0
    });
  }

  po.supplierId = oid(supplierId);
  po.expectedTotalAmount = expectedTotalAmount;
  po.notes = notes || undefined;
  await po.save();

  await PurchaseOrderLine.insertMany(
    lineDocs.map((d) => ({ ...d, purchaseOrderId: poid })),
    { ordered: false }
  );

  const full = await getById(companyId, po._id);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'procurement.po.update',
    entityType: 'PurchaseOrder',
    entityId: po._id,
    changes: { after: full }
  });
  return full;
};

const approve = async (companyId, id, reqUser) => {
  const po = await PurchaseOrder.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
  if (!po) throw new ApiError(404, 'Purchase order not found');
  if (po.status !== PURCHASE_ORDER_STATUS.DRAFT) {
    throw new ApiError(400, 'Only draft purchase orders can be approved');
  }

  po.status = PURCHASE_ORDER_STATUS.APPROVED;
  po.approvedAt = new Date();
  po.approvedBy = oid(reqUser.userId);
  await po.save();

  const full = await getById(companyId, po._id);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'procurement.po.approve',
    entityType: 'PurchaseOrder',
    entityId: po._id,
    changes: { after: full }
  });
  return full;
};

module.exports = {
  list,
  getById,
  create,
  updateById,
  approve
};
