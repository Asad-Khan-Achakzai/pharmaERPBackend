const mongoose = require('mongoose');
const { PAYMENT_METHOD } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const paymentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    pharmacyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', required: true },
    amount: { type: Number, required: true },
    paymentMethod: { type: String, enum: Object.values(PAYMENT_METHOD), required: true },
    referenceNumber: { type: String },
    collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: Date, default: Date.now },
    notes: { type: String }
  },
  { timestamps: true }
);

paymentSchema.index({ companyId: 1, pharmacyId: 1, date: -1 });
paymentSchema.index({ companyId: 1, collectedBy: 1 });

paymentSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Payment', paymentSchema);
