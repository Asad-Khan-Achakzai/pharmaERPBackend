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
    avgCostAtTime: { type: Number },
    finalSellingPrice: { type: Number },
    lineCreditAmount: { type: Number },
    companyShare: { type: Number },
    distributorShare: { type: Number },
    tpDelta: { type: Number },
    deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryRecord' }
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
orderAmendmentSchema.index(
  { companyId: 1, amendmentNumber: 1 },
  { unique: true, partialFilterExpression: { amendmentNumber: { $type: 'string' } } }
);

orderAmendmentSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('OrderAmendment', orderAmendmentSchema);
