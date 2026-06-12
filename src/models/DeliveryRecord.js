const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const deliveryItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    /** Physical packs shipped in this delivery (paid + bonus). */
    quantity: { type: Number, required: true },
    /** Paid packs drive pharmacy net / commission; gross TP uses physical (paid + bonus) packs. */
    paidQuantity: { type: Number },
    /** Bonus/free packs in this batch (omit on legacy rows — PDF infers from TP vs physical qty). */
    bonusQuantity: { type: Number },
    avgCostAtTime: { type: Number },
    finalSellingPrice: { type: Number },
    profitPerUnit: { type: Number },
    totalProfit: { type: Number },
    /** TP × physical qty (paid + bonus) — base for Gross Sales (TP) rollups */
    tpLineTotal: { type: Number },
    /** Frozen distributor share on TP line (PKR) */
    distributorShare: { type: Number },
    /** Line pharmacy net (after both discounts) */
    linePharmacyNet: { type: Number },
    /** linePharmacyNet - distributorShare */
    companyShare: { type: Number }
  },
  { _id: false }
);

const deliveryRecordSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    invoiceNumber: { type: String },
    items: [deliveryItemSchema],
    totalAmount: { type: Number },
    totalCost: { type: Number },
    totalProfit: { type: Number },
    /** Sum of TP×physical qty for delivered lines (paid + bonus) */
    tpSubtotal: { type: Number, default: 0 },
    /** Sum of distributor shares (PKR) */
    distributorShareTotal: { type: Number, default: 0 },
    /** Same as totalAmount — pharmacy invoice total */
    pharmacyNetPayable: { type: Number, default: 0 },
    /** pharmacyNetPayable - distributorShareTotal */
    companyShareTotal: { type: Number, default: 0 },
    /** Commission % on TP used for this delivery (snapshot) */
    distributorCommissionPercent: { type: Number },
    deliveredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deliveredAt: { type: Date, default: Date.now },
    pdfUrl: { type: String }
  },
  { timestamps: true }
);

deliveryRecordSchema.index({ companyId: 1, orderId: 1 });
deliveryRecordSchema.index({ companyId: 1, deliveredAt: -1 });

deliveryRecordSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('DeliveryRecord', deliveryRecordSchema);
