const mongoose = require('mongoose');
const GoodsReceiptNote = require('../models/GoodsReceiptNote');
const GoodsReceiptLine = require('../models/GoodsReceiptLine');
const PurchaseOrderLine = require('../models/PurchaseOrderLine');
const PurchaseReturn = require('../models/PurchaseReturn');
const SupplierInvoice = require('../models/SupplierInvoice');
const SupplierLedger = require('../models/SupplierLedger');
const { mergeIntoDestination } = require('./inventory.service');
const supplierService = require('./supplier.service');
const auditService = require('./audit.service');
const goodsReceiptService = require('./goodsReceipt.service');
const ApiError = require('../utils/ApiError');
const { roundPKR } = require('../utils/currency');
const {
  GOODS_RECEIPT_NOTE_STATUS,
  PURCHASE_RETURN_STATUS,
  SUPPLIER_LEDGER_TYPE,
  SUPPLIER_LEDGER_REFERENCE_TYPE,
  SUPPLIER_INVOICE_STATUS
} = require('../constants/enums');

const oid = (id) => new mongoose.Types.ObjectId(id);

/**
 * Emergency full reversal of a posted GRN. Does not delete rows; marks GRN REVERSED.
 * Blocked when posted purchase returns exist or a posted supplier invoice references this GRN.
 */
const reversePostedGrn = async (companyId, grnId, body, reqUser) => {
  const cid = oid(companyId);
  const gid = oid(grnId);

  const quick = await GoodsReceiptNote.findOne({ _id: gid, companyId: cid, isDeleted: { $ne: true } }).lean();
  if (!quick) throw new ApiError(404, 'Goods receipt not found');
  if (quick.status === GOODS_RECEIPT_NOTE_STATUS.REVERSED) {
    return goodsReceiptService.getById(companyId, grnId);
  }
  if (quick.status !== GOODS_RECEIPT_NOTE_STATUS.POSTED) {
    throw new ApiError(400, 'Only posted goods receipts can be reversed');
  }

  const prExists = await PurchaseReturn.countDocuments({
    companyId: cid,
    grnId: gid,
    status: PURCHASE_RETURN_STATUS.POSTED,
    isDeleted: { $ne: true }
  });
  if (prExists > 0) {
    throw new ApiError(
      409,
      'Cannot reverse: purchase returns exist for this receipt. Use the purchase return workflow instead.'
    );
  }

  const invBlock = await SupplierInvoice.findOne({
    companyId: cid,
    status: SUPPLIER_INVOICE_STATUS.POSTED,
    grnIds: gid,
    isDeleted: { $ne: true }
  }).lean();
  if (invBlock) {
    throw new ApiError(
      409,
      'Cannot reverse: a posted supplier invoice references this receipt. Resolve the invoice first.'
    );
  }

  const purchaseRow = await SupplierLedger.findOne({
    companyId: cid,
    supplierId: quick.supplierId,
    type: SUPPLIER_LEDGER_TYPE.PURCHASE,
    referenceType: SUPPLIER_LEDGER_REFERENCE_TYPE.GOODS_RECEIPT_NOTE,
    referenceId: gid,
    isDeleted: { $ne: true }
  }).lean();
  if (!purchaseRow) {
    throw new ApiError(
      400,
      'No supplier purchase ledger entry found for this receipt; cannot reverse automatically'
    );
  }

  const lines = await GoodsReceiptLine.find({ grnId: gid, companyId: cid, isDeleted: { $ne: true } }).lean();
  if (!lines.length) throw new ApiError(400, 'Goods receipt has no lines');

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const grn = await GoodsReceiptNote.findOne({
      _id: gid,
      companyId: cid,
      status: GOODS_RECEIPT_NOTE_STATUS.POSTED,
      isDeleted: { $ne: true }
    }).session(session);
    if (!grn) {
      await session.abortTransaction();
      const rev = await GoodsReceiptNote.findOne({
        _id: gid,
        companyId: cid,
        status: GOODS_RECEIPT_NOTE_STATUS.REVERSED,
        isDeleted: { $ne: true }
      }).lean();
      if (rev) return goodsReceiptService.getById(companyId, grnId);
      throw new ApiError(400, 'Goods receipt is not posted');
    }

    for (const line of lines) {
      const qty = line.qtyReceived;
      if (qty <= 0) continue;
      const landed = roundPKR(Number(line.unitCost));
      await mergeIntoDestination({
        session,
        companyId: cid,
        distributorId: line.distributorId,
        productId: line.productId,
        quantity: qty,
        newCostPerUnit: landed,
        reqUser,
        operationType: 'OUT'
      });

      if (line.purchaseOrderLineId) {
        const pol = await PurchaseOrderLine.findOne({
          _id: line.purchaseOrderLineId,
          companyId: cid,
          isDeleted: { $ne: true }
        }).session(session);
        if (pol) {
          if (pol.receivedQty + 1e-9 < qty) {
            throw new ApiError(400, 'Purchase order line received quantity is inconsistent; refuse reversal');
          }
          pol.receivedQty = Math.max(0, pol.receivedQty - qty);
          await pol.save({ session });
        }
      }
    }

    await goodsReceiptService.recomputePoStatus(session, cid, grn.purchaseOrderId);

    await supplierService.recordGrnReversalPosted(
      {
        session,
        companyId: cid,
        supplierId: grn.supplierId,
        grnId: grn._id,
        amount: roundPKR(purchaseRow.amount),
        notes: `GRN reversal ${grn.receiptNumber}`
      },
      reqUser
    );

    grn.status = GOODS_RECEIPT_NOTE_STATUS.REVERSED;
    grn.reversedAt = new Date();
    grn.reversedBy = oid(reqUser.userId);
    grn.reversalReason = body?.reason || undefined;
    await grn.save({ session });

    await session.commitTransaction();

    const full = await goodsReceiptService.getById(companyId, grnId);
    await auditService.log({
      companyId: cid,
      userId: reqUser.userId,
      action: 'procurement.grn.reverse',
      entityType: 'GoodsReceiptNote',
      entityId: grn._id,
      changes: {
        after: full,
        reason: body?.reason || null,
        meta: { purchaseLedgerAmount: purchaseRow.amount }
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

module.exports = { reversePostedGrn };
