const mongoose = require('mongoose');
const { PURCHASE_RETURN_STATUS } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const purchaseReturnSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    grnId: { type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceiptNote', required: true, index: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true, index: true },
    returnNumber: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: Object.values(PURCHASE_RETURN_STATUS),
      default: PURCHASE_RETURN_STATUS.DRAFT,
      index: true
    },
    returnedAt: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: 4000 },
    reason: { type: String, trim: true, maxlength: 4000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    postedAt: { type: Date, default: null },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

purchaseReturnSchema.index({ companyId: 1, returnNumber: 1 }, { unique: true });
purchaseReturnSchema.index({ companyId: 1, grnId: 1, status: 1 });

purchaseReturnSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('PurchaseReturn', purchaseReturnSchema);
