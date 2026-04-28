const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const goodsReceiptLineSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    /** Parent GRN */
    grnId: { type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceiptNote', required: true, index: true },
    /** Optional link back to PO line for receivedQty roll-up */
    purchaseOrderLineId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrderLine', default: null },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    qtyReceived: { type: Number, required: true, min: 0 },
    /**
     * Landed unit cost (PKR) — product/factory portion + this receipt's share of shipping.
     * Used for inventory (mergeIntoDestination).
     */
    unitCost: { type: Number, required: true, min: 0 },
    /**
     * Factory / supplier-bill unit cost (PKR), excludes shipping. Supplier ledger PURCHASE uses qty × this when set;
     * otherwise falls back to unitCost (legacy GRNs).
     */
    factoryUnitCost: { type: Number, min: 0 },
    /** Destination stock bucket — required for DistributorInventory posting */
    distributorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Distributor', required: true },
    notes: { type: String, trim: true, maxlength: 2000 }
  },
  { timestamps: true }
);

goodsReceiptLineSchema.index({ companyId: 1, grnId: 1, productId: 1 });
goodsReceiptLineSchema.index({ grnId: 1, productId: 1 });

goodsReceiptLineSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('GoodsReceiptLine', goodsReceiptLineSchema);
