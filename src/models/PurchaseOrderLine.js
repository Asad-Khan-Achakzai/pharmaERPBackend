const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const purchaseOrderLineSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true, index: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    orderedQty: { type: Number, required: true, min: 0 },
    receivedQty: { type: Number, default: 0, min: 0 },
    /** Expected unit price (PKR); actual cost comes from GRN lines */
    unitPrice: { type: Number, default: 0, min: 0 },
    notes: { type: String, trim: true, maxlength: 2000 }
  },
  { timestamps: true }
);

purchaseOrderLineSchema.index({ purchaseOrderId: 1, productId: 1 });
purchaseOrderLineSchema.index({ companyId: 1, purchaseOrderId: 1 });

purchaseOrderLineSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('PurchaseOrderLine', purchaseOrderLineSchema);
