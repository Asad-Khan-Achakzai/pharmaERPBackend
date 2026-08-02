const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');
const { TAX_POSTING_STATUS } = require('../constants/taxCatalog');

const deliveryTaxLineSchema = new mongoose.Schema(
  {
    sequence: { type: Number, required: true },
    taxTypeCode: { type: String, required: true },
    taxTypeName: { type: String, default: '' },
    taxSection: { type: String, default: '' },
    taxDescription: { type: String, default: '' },
    calculationBase: { type: String, default: '' },
    calculationBaseAmount: { type: Number, default: 0 },
    ratePercent: { type: Number, default: null },
    taxAmount: { type: Number, required: true },
    postingBehavior: { type: String, default: '' },
    liabilityAccountCode: { type: String, default: '' },
    taxRuleId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxRule', default: null },
    rateVersionId: { type: mongoose.Schema.Types.ObjectId, default: null }
  },
  { _id: false }
);

const deliveryTaxSnapshotSchema = new mongoose.Schema(
  {
    engineVersion: { type: String, default: '' },
    postingVersion: { type: String, default: '' },
    calculatedAt: { type: Date },
    businessDate: { type: Date },
    countryCode: { type: String, default: '' },
    currency: { type: String, default: '' },
    pharmacyTaxStatus: { type: String, default: '' },
    pharmacyLicenseNumber: { type: String, default: '' },
    pharmacyNtn: { type: String, default: '' },
    pharmacyStrn: { type: String, default: '' },
    taxExempt: { type: Boolean, default: false },
    taxExemptReason: { type: String, default: '' },
    executionOrderApplied: { type: [String], default: [] },
    lines: { type: [deliveryTaxLineSchema], default: [] },
    amounts: {
      goodsNetPayable: { type: Number, default: 0 },
      taxTotal: { type: Number, default: 0 },
      invoiceGrandTotal: { type: Number, default: 0 }
    }
  },
  { _id: false }
);

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
    /** Same as totalAmount — pharmacy goods net (excludes tax) */
    pharmacyNetPayable: { type: Number, default: 0 },
    /** Explicit goods net alias (= pharmacyNetPayable on write when tax enabled). */
    goodsNetPayable: { type: Number, default: null },
    /** Sum of additive tax − withholding from taxSnapshot. */
    taxTotal: { type: Number, default: 0 },
    /** Amount customer owes (goods + additive tax − withholding). Legacy docs omit → use pharmacyNetPayable. */
    invoiceGrandTotal: { type: Number, default: null },
    /** Immutable tax freeze at delivery posting. */
    taxSnapshot: { type: deliveryTaxSnapshotSchema, default: undefined },
    taxPostingStatus: {
      type: String,
      enum: Object.values(TAX_POSTING_STATUS),
      default: TAX_POSTING_STATUS.NOT_APPLICABLE
    },
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
