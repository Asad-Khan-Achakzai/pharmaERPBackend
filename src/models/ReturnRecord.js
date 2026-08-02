const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const returnItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true },
    /** Bonus-First (v1): paid packs reversed for AR money. */
    paidDelta: { type: Number, default: 0 },
    /** Bonus-First (v1): bonus packs reversed first. */
    bonusDelta: { type: Number, default: 0 },
    allocationPolicy: { type: String, default: 'BONUS_FIRST' },
    avgCostAtTime: { type: Number },
    /** Historical paid-unit pharmacy net from delivery snapshot. */
    finalSellingPrice: { type: Number },
    lineCreditAmount: { type: Number },
    /** Company P&L revenue reversed from paidDelta × historical company share */
    companyShare: { type: Number },
    distributorShare: { type: Number },
    profitPerUnit: { type: Number },
    totalProfit: { type: Number },
    reason: { type: String }
  },
  { _id: false }
);

/** Invoice application SoT for returns (mirrors Collection.allocations). */
const returnAllocationSchema = new mongoose.Schema(
  {
    deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryRecord', required: true },
    amount: { type: Number, required: true }
  },
  { _id: false }
);

const returnRecordSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    items: [returnItemSchema],
    totalAmount: { type: Number },
    totalCost: { type: Number },
    totalProfit: { type: Number },
    /** Authoritative application of this return credit to order deliveries */
    allocations: [returnAllocationSchema],
    returnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    returnedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

returnRecordSchema.index({ companyId: 1, orderId: 1 });
returnRecordSchema.index({ companyId: 1, 'allocations.deliveryId': 1 });

returnRecordSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('ReturnRecord', returnRecordSchema);
