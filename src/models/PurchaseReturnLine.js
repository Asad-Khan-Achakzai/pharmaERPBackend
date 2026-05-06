const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const purchaseReturnLineSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    purchaseReturnId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseReturn', required: true, index: true },
    goodsReceiptLineId: { type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceiptLine', required: true, index: true },
    qtyReturned: { type: Number, required: true, min: 0 },
    notes: { type: String, trim: true, maxlength: 2000 }
  },
  { timestamps: true }
);

purchaseReturnLineSchema.index({ companyId: 1, purchaseReturnId: 1, goodsReceiptLineId: 1 });

purchaseReturnLineSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('PurchaseReturnLine', purchaseReturnLineSchema);
