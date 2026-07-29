const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const returnItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true },
    avgCostAtTime: { type: Number },
    finalSellingPrice: { type: Number },
    /** Company P&L revenue reversed (proportional to delivery line companyShare) */
    companyShare: { type: Number },
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
