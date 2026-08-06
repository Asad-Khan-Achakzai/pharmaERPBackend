const mongoose = require('mongoose');
const {
  AMENDMENT_TYPE,
  AMENDMENT_SOURCE,
  AMENDMENT_STATUS
} = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const amendmentItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String },
    previousQty: { type: Number, required: true },
    newQty: { type: Number, required: true },
    deltaQty: { type: Number, required: true },
    /** Bonus-First (v1): paid packs reversed for AR / CN money. */
    paidDelta: { type: Number, default: 0 },
    /** Bonus-First (v1): bonus packs reversed (inventory/TP only when paidDelta=0). */
    bonusDelta: { type: Number, default: 0 },
    allocationPolicy: { type: String, default: 'BONUS_FIRST' },
    avgCostAtTime: { type: Number },
    /** Historical paid-unit pharmacy net from delivery snapshot (CN rate). */
    finalSellingPrice: { type: Number },
    lineCreditAmount: { type: Number },
    companyShare: { type: Number },
    distributorShare: { type: Number },
    tpDelta: { type: Number },
    deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryRecord' },
    /** Alias snapshot of deliveryId for reporting (kept in sync at write). */
    sourceDeliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryRecord' },
    sourceDeliveredAt: { type: Date },
    /** Company-TZ YYYY-MM of sourceDeliveredAt at write time. */
    sourceDeliveryYm: { type: String },
    sourceInvoiceNumber: { type: String }
  },
  { _id: false }
);

/** Invoice application SoT for amendments (mirrors ReturnRecord.allocations). */
const amendmentAllocationSchema = new mongoose.Schema(
  {
    deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryRecord', required: true },
    amount: { type: Number, required: true }
  },
  { _id: false }
);

const orderAmendmentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    amendmentNumber: { type: String },
    version: { type: Number, required: true },
    amendmentType: {
      type: String,
      enum: Object.values(AMENDMENT_TYPE),
      default: AMENDMENT_TYPE.QUANTITY_REDUCTION,
      required: true
    },
    source: {
      type: String,
      enum: Object.values(AMENDMENT_SOURCE),
      default: AMENDMENT_SOURCE.DELIVERED_ORDER_CORRECTION,
      required: true
    },
    status: {
      type: String,
      enum: Object.values(AMENDMENT_STATUS),
      default: AMENDMENT_STATUS.APPLIED
    },
    reason: { type: String, required: true },
    items: [amendmentItemSchema],
    allocations: [amendmentAllocationSchema],
    totalAmount: { type: Number },
    totalCost: { type: Number },
    totalProfit: { type: Number },
    tpDeltaTotal: { type: Number, default: 0 },
    /** Auditor-facing snapshot of modules touched at apply time. */
    affectedModules: [{ type: String }],
    orderNumber: { type: String },
    pharmacyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy' },
    distributorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Distributor' },
    invoiceNumbers: [{ type: String }],
    deliveryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryRecord' }],
    amendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amendedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

orderAmendmentSchema.index({ companyId: 1, orderId: 1 });
orderAmendmentSchema.index({ companyId: 1, 'allocations.deliveryId': 1 });
orderAmendmentSchema.index({ companyId: 1, amendedAt: -1 });
orderAmendmentSchema.index({ companyId: 1, 'items.sourceDeliveryYm': 1, amendedAt: -1 });
orderAmendmentSchema.index(
  { companyId: 1, amendmentNumber: 1 },
  { unique: true, partialFilterExpression: { amendmentNumber: { $type: 'string' } } }
);

orderAmendmentSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('OrderAmendment', orderAmendmentSchema);
