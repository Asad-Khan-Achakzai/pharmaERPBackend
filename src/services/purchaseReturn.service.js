const mongoose = require('mongoose');
const PurchaseReturn = require('../models/PurchaseReturn');
const PurchaseReturnLine = require('../models/PurchaseReturnLine');
const GoodsReceiptNote = require('../models/GoodsReceiptNote');
const GoodsReceiptLine = require('../models/GoodsReceiptLine');
const PurchaseOrderLine = require('../models/PurchaseOrderLine');
const SupplierInvoice = require('../models/SupplierInvoice');
const SupplierLedger = require('../models/SupplierLedger');
const { mergeIntoDestination } = require('./inventory.service');
const supplierService = require('./supplier.service');
const auditService = require('./audit.service');
const ApiError = require('../utils/ApiError');
const { roundPKR } = require('../utils/currency');
const { parsePagination } = require('../utils/pagination');
const { getNextSequenceNumber } = require('../utils/orderNumber');
const goodsReceiptService = require('./goodsReceipt.service');
const {
  GOODS_RECEIPT_NOTE_STATUS,
  PURCHASE_RETURN_STATUS,
  SUPPLIER_LEDGER_TYPE,
  SUPPLIER_LEDGER_REFERENCE_TYPE,
  SUPPLIER_INVOICE_STATUS
} = require('../constants/enums');

const oid = (id) => new mongoose.Types.ObjectId(id);

async function sumPostedReturnsByGrnLine(companyId, grnId, session) {
  const posted = await PurchaseReturn.find({ companyId, grnId, status: PURCHASE_RETURN_STATUS.POSTED })
    .select('_id')
    .session(session || null)
    .lean();
  const ids = posted.map((p) => p._id);
  if (!ids.length) return new Map();
  const lines = await PurchaseReturnLine.find({
    companyId,
    purchaseReturnId: { $in: ids },
    isDeleted: { $ne: true }
  })
    .session(session || null)
    .lean();
  const m = new Map();
  for (const l of lines) {
    const k = String(l.goodsReceiptLineId);
    m.set(k, (m.get(k) || 0) + l.qtyReturned);
  }
  return m;
}

const factoryUnitForPayable = (line) =>
  line.factoryUnitCost != null && line.factoryUnitCost !== undefined
    ? roundPKR(Number(line.factoryUnitCost))
    : roundPKR(Number(line.unitCost));

const getReturnableCaps = async (companyId, grnId) => {
  const grn = await GoodsReceiptNote.findOne({ _id: grnId, companyId, isDeleted: { $ne: true } }).lean();
  if (!grn) throw new ApiError(404, 'Goods receipt not found');
  if (grn.status !== GOODS_RECEIPT_NOTE_STATUS.POSTED) {
    throw new ApiError(400, 'Returnable quantities are only defined for posted receipts');
  }
  const glines = await GoodsReceiptLine.find({ grnId, companyId, isDeleted: { $ne: true } })
    .sort({ createdAt: 1 })
    .lean();
  const returnedMap = await sumPostedReturnsByGrnLine(companyId, grnId, null);
  return {
    grnId,
    lines: glines.map((l) => {
      const rid = String(l._id);
      const already = returnedMap.get(rid) || 0;
      const max = Math.max(0, l.qtyReceived - already);
      return {
        goodsReceiptLineId: l._id,
        productId: l.productId,
        qtyReceived: l.qtyReceived,
        alreadyReturned: already,
        maxReturnable: max,
        unitCost: l.unitCost
      };
    })
  };
};

const getById = async (companyId, id) => {
  const doc = await PurchaseReturn.findOne({ _id: id, companyId, isDeleted: { $ne: true } })
    .populate('supplierId', 'name')
    .populate('grnId', 'receiptNumber status')
    .populate('purchaseOrderId', 'orderNumber status')
    .lean();
  if (!doc) throw new ApiError(404, 'Purchase return not found');
  const lines = await PurchaseReturnLine.find({ purchaseReturnId: doc._id, companyId, isDeleted: { $ne: true } })
    .populate('goodsReceiptLineId', 'qtyReceived unitCost factoryUnitCost productId distributorId purchaseOrderLineId')
    .lean();
  return { ...doc, lines };
};

const list = async (companyId, query = {}) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId, isDeleted: { $ne: true } };
  if (query.grnId) filter.grnId = query.grnId;
  const [docs, total] = await Promise.all([
    PurchaseReturn.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    PurchaseReturn.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const validateAndBuildLines = async (companyId, grnId, lineInputs, session) => {
  const grn = await GoodsReceiptNote.findOne({ _id: grnId, companyId, isDeleted: { $ne: true } }).session(
    session || null
  );
  if (!grn) throw new ApiError(404, 'Goods receipt not found');
  if (grn.status === GOODS_RECEIPT_NOTE_STATUS.REVERSED) {
    throw new ApiError(400, 'Cannot return against a reversed goods receipt');
  }
  if (grn.status !== GOODS_RECEIPT_NOTE_STATUS.POSTED) {
    throw new ApiError(400, 'Purchase returns require a posted goods receipt');
  }

  const returnedMap = await sumPostedReturnsByGrnLine(companyId, grnId, session);
  const mergedQtyByLine = new Map();
  const notesByLine = new Map();

  for (const li of lineInputs) {
    const key = String(li.goodsReceiptLineId);
    const qty = Number(li.qtyReturned);
    if (Number.isFinite(qty) && qty > 0) {
      mergedQtyByLine.set(key, (mergedQtyByLine.get(key) || 0) + qty);
      if (li.notes && String(li.notes).trim()) {
        const prev = notesByLine.get(key);
        const n = String(li.notes).trim();
        notesByLine.set(key, prev ? `${prev}; ${n}` : n);
      }
    }
  }

  const out = [];

  for (const [gidStr, qty] of mergedQtyByLine) {
    const grnLine = await GoodsReceiptLine.findOne({
      _id: gidStr,
      companyId,
      grnId,
      isDeleted: { $ne: true }
    }).session(session || null);
    if (!grnLine) throw new ApiError(400, 'Invalid goods receipt line');

    const already = returnedMap.get(String(grnLine._id)) || 0;
    const max = grnLine.qtyReceived - already;
    if (qty > max + 1e-9) {
      throw new ApiError(400, `Return quantity exceeds remaining for a line (max ${max})`);
    }

    returnedMap.set(String(grnLine._id), already + qty);

    out.push({
      goodsReceiptLineId: grnLine._id,
      qtyReturned: qty,
      notes: notesByLine.get(gidStr) || undefined
    });
  }

  if (!out.length) throw new ApiError(400, 'At least one line with positive return quantity is required');

  return { grn, out };
};

const create = async (companyId, body, reqUser) => {
  const { grnId, notes, reason, lines } = body;

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { grn, out } = await validateAndBuildLines(companyId, grnId, lines, session);

    const returnNumber = await getNextSequenceNumber(companyId, 'PRT', { session });

    const [doc] = await PurchaseReturn.create(
      [
        {
          companyId: oid(companyId),
          grnId: grn._id,
          supplierId: grn.supplierId,
          purchaseOrderId: grn.purchaseOrderId,
          returnNumber,
          status: PURCHASE_RETURN_STATUS.DRAFT,
          notes: notes || undefined,
          reason: reason || undefined,
          createdBy: reqUser.userId
        }
      ],
      { session }
    );

    const lineDocs = out.map((o) => ({
      companyId: oid(companyId),
      purchaseReturnId: doc._id,
      goodsReceiptLineId: o.goodsReceiptLineId,
      qtyReturned: o.qtyReturned,
      notes: o.notes
    }));
    await PurchaseReturnLine.insertMany(lineDocs, { session });

    await session.commitTransaction();
    return getById(companyId, doc._id);
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
};

const updateById = async (companyId, id, body, reqUser) => {
  const cid = oid(companyId);
  const rid = oid(id);
  const doc = await PurchaseReturn.findOne({ _id: rid, companyId: cid, isDeleted: { $ne: true } });
  if (!doc) throw new ApiError(404, 'Purchase return not found');
  if (doc.status !== PURCHASE_RETURN_STATUS.DRAFT) throw new ApiError(400, 'Only draft purchase returns can be edited');

  const { notes, reason, lines } = body;

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await PurchaseReturnLine.updateMany(
      { purchaseReturnId: rid, companyId: cid, isDeleted: { $ne: true } },
      { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: oid(reqUser.userId) } }
    );

    const { out } = await validateAndBuildLines(companyId, doc.grnId, lines, session);

    if (notes !== undefined) doc.notes = notes || undefined;
    if (reason !== undefined) doc.reason = reason || undefined;
    await doc.save({ session });

    const lineDocs = out.map((o) => ({
      companyId: cid,
      purchaseReturnId: rid,
      goodsReceiptLineId: o.goodsReceiptLineId,
      qtyReturned: o.qtyReturned,
      notes: o.notes
    }));
    await PurchaseReturnLine.insertMany(lineDocs, { session });

    await session.commitTransaction();
    return getById(companyId, rid);
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
};

const post = async (companyId, id, body, reqUser) => {
  const cid = oid(companyId);
  const rid = oid(id);

  const quick = await PurchaseReturn.findOne({ _id: rid, companyId: cid, isDeleted: { $ne: true } }).lean();
  if (!quick) throw new ApiError(404, 'Purchase return not found');
  if (quick.status === PURCHASE_RETURN_STATUS.POSTED) {
    return getById(companyId, id);
  }
  if (quick.status !== PURCHASE_RETURN_STATUS.DRAFT) throw new ApiError(400, 'Purchase return cannot be posted');

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const pr = await PurchaseReturn.findOne({
      _id: rid,
      companyId: cid,
      status: PURCHASE_RETURN_STATUS.DRAFT,
      isDeleted: { $ne: true }
    }).session(session);
    if (!pr) {
      await session.abortTransaction();
      const posted = await PurchaseReturn.findOne({
        _id: rid,
        companyId: cid,
        status: PURCHASE_RETURN_STATUS.POSTED,
        isDeleted: { $ne: true }
      }).lean();
      if (posted) return getById(companyId, id);
      throw new ApiError(400, 'Purchase return is not in draft status');
    }

    const lines = await PurchaseReturnLine.find({
      purchaseReturnId: rid,
      companyId: cid,
      isDeleted: { $ne: true }
    }).session(session);
    if (!lines.length) throw new ApiError(400, 'Purchase return has no lines');

    const grn = await GoodsReceiptNote.findOne({ _id: pr.grnId, companyId: cid, isDeleted: { $ne: true } }).session(
      session
    );
    if (!grn || grn.status !== GOODS_RECEIPT_NOTE_STATUS.POSTED) {
      throw new ApiError(400, 'Goods receipt must still be posted');
    }

    const returnedMap = await sumPostedReturnsByGrnLine(cid, pr.grnId, session);

    let payableTotal = 0;

    for (const line of lines) {
      const grnLine = await GoodsReceiptLine.findOne({
        _id: line.goodsReceiptLineId,
        companyId: cid,
        grnId: pr.grnId,
        isDeleted: { $ne: true }
      }).session(session);
      if (!grnLine) throw new ApiError(400, 'Invalid goods receipt line on purchase return');

      const key = String(grnLine._id);
      const already = returnedMap.get(key) || 0;
      const max = grnLine.qtyReceived - already;
      if (line.qtyReturned > max + 1e-9) {
        throw new ApiError(400, 'Return quantity no longer valid for a line');
      }
      returnedMap.set(key, already + line.qtyReturned);

      const qty = line.qtyReturned;
      const landed = roundPKR(Number(grnLine.unitCost));
      await mergeIntoDestination({
        session,
        companyId: cid,
        distributorId: grnLine.distributorId,
        productId: grnLine.productId,
        quantity: qty,
        newCostPerUnit: landed,
        reqUser,
        operationType: 'OUT'
      });

      payableTotal = roundPKR(payableTotal + qty * factoryUnitForPayable(grnLine));

      if (grnLine.purchaseOrderLineId) {
        await PurchaseOrderLine.updateOne(
          { _id: grnLine.purchaseOrderLineId, companyId: cid, isDeleted: { $ne: true } },
          { $inc: { returnedQtyToSupplier: qty } },
          { session }
        );
      }
    }

    await supplierService.recordPurchaseReturnPosted(
      {
        session,
        companyId: cid,
        supplierId: pr.supplierId,
        purchaseReturnId: pr._id,
        amount: payableTotal,
        notes: `Purchase return ${pr.returnNumber}`
      },
      reqUser
    );

    pr.status = PURCHASE_RETURN_STATUS.POSTED;
    pr.returnedAt = new Date();
    pr.postedAt = new Date();
    pr.postedBy = oid(reqUser.userId);
    await pr.save({ session });

    await session.commitTransaction();

    const full = await getById(companyId, id);
    await auditService.log({
      companyId: cid,
      userId: reqUser.userId,
      action: 'procurement.purchaseReturn.post',
      entityType: 'PurchaseReturn',
      entityId: pr._id,
      changes: {
        after: full,
        reason: (body && body.reason) || pr.reason || null,
        meta: { payableTotal }
      }
    });
    return full;
  } catch (e) {
    try {
      await session.abortTransaction();
    } catch (_) {
      /* noop */
    }
    throw e;
  } finally {
    session.endSession();
  }
};

module.exports = {
  getReturnableCaps,
  getById,
  list,
  create,
  updateById,
  post
};
