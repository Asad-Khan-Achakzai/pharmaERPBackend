const mongoose = require('mongoose');
const { COLLECTOR_TYPE, PAYMENT_METHOD } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const allocationSchema = new mongoose.Schema(
  {
    deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryRecord', required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    distributorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Distributor', required: true },
    amount: { type: Number, required: true }
  },
  { _id: false }
);

const collectionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    pharmacyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', required: true },
    /** When collectorType is DISTRIBUTOR: which distributor collected; allocation is FIFO only against that distributor's deliveries for this pharmacy. */
    distributorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Distributor' },
    collectorType: { type: String, enum: Object.values(COLLECTOR_TYPE), required: true },
    amount: { type: Number, required: true },
    paymentMethod: { type: String, enum: Object.values(PAYMENT_METHOD), required: true },
    referenceNumber: { type: String },
    collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: Date, default: Date.now },
    notes: { type: String },
    /** FIFO allocation of this collection against pharmacy receivable (per delivery) */
    allocations: [allocationSchema]
  },
  { timestamps: true }
);

collectionSchema.index({ companyId: 1, pharmacyId: 1, date: -1 });
collectionSchema.index({ companyId: 1, collectorType: 1, date: -1 });
collectionSchema.index({ companyId: 1, distributorId: 1, date: -1 });

collectionSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Collection', collectionSchema);
