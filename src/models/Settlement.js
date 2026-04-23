const mongoose = require('mongoose');
const { SETTLEMENT_DIRECTION, PAYMENT_METHOD } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const settlementSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    distributorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Distributor', required: true },
    direction: { type: String, enum: Object.values(SETTLEMENT_DIRECTION), required: true },
    amount: { type: Number, required: true },
    paymentMethod: { type: String, enum: Object.values(PAYMENT_METHOD), required: true },
    referenceNumber: { type: String },
    settledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: Date, default: Date.now },
    notes: { type: String },
    /** True when this settlement is the net of two gross legs */
    isNetSettlement: { type: Boolean, default: false },
    grossDistributorToCompany: { type: Number },
    grossCompanyToDistributor: { type: Number }
  },
  { timestamps: true }
);

settlementSchema.index({ companyId: 1, distributorId: 1, date: -1 });

settlementSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Settlement', settlementSchema);
