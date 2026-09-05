const mongoose = require('mongoose');
const {
  REMITTANCE_KIND,
  REMITTANCE_STATUS,
  REMITTANCE_DIFFERENCE_REASON,
  PAYMENT_METHOD
} = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const remittanceSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    distributorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Distributor', required: true },
    kind: { type: String, enum: Object.values(REMITTANCE_KIND), required: true },
    status: { type: String, enum: Object.values(REMITTANCE_STATUS), default: REMITTANCE_STATUS.POSTED },
    settlementId: { type: mongoose.Schema.Types.ObjectId, ref: 'Settlement', default: null },
    /** Sum of pharmacy collection amounts included in this handover */
    collectedAmount: { type: Number, required: true },
    /** Sum of company-share remittance due on included collections (Model A expected) */
    expectedAmount: { type: Number, required: true },
    /** Cash actually received by the company */
    receivedAmount: { type: Number, required: true },
    /** received − expected (0 or negative in Phase 1) */
    differenceAmount: { type: Number, required: true },
    differenceReason: {
      type: String,
      enum: Object.values(REMITTANCE_DIFFERENCE_REASON),
      default: undefined
    },
    paymentMethod: { type: String, enum: Object.values(PAYMENT_METHOD), required: true },
    moneyAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    moneyAccountNature: { type: String, enum: ['CASH', 'BANK'], default: null },
    referenceNumber: { type: String },
    notes: { type: String },
    date: { type: Date, default: Date.now },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

remittanceSchema.index({ companyId: 1, distributorId: 1, date: -1 });
remittanceSchema.index({ companyId: 1, settlementId: 1 });

remittanceSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Remittance', remittanceSchema);
