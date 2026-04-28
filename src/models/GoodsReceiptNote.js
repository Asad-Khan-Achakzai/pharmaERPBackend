const mongoose = require('mongoose');
const { GOODS_RECEIPT_NOTE_STATUS } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const goodsReceiptNoteSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true, index: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
    /** Unique per company — generated in service */
    receiptNumber: { type: String, required: true, trim: true },
    receivedAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: Object.values(GOODS_RECEIPT_NOTE_STATUS),
      default: GOODS_RECEIPT_NOTE_STATUS.DRAFT,
      index: true
    },
    postedAt: { type: Date, default: null },
    /** Lump shipping for this receipt (PKR); not included in supplier payable, only in landed inventory cost */
    totalShippingCost: { type: Number, default: 0, min: 0 },
    notes: { type: String, trim: true, maxlength: 4000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

goodsReceiptNoteSchema.index({ companyId: 1, receiptNumber: 1 }, { unique: true });
goodsReceiptNoteSchema.index({ companyId: 1, purchaseOrderId: 1, receivedAt: -1 });

goodsReceiptNoteSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('GoodsReceiptNote', goodsReceiptNoteSchema);
