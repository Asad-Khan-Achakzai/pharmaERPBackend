const mongoose = require('mongoose');
const { TRANSACTION_TYPE } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const transactionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    type: { type: String, enum: Object.values(TRANSACTION_TYPE), required: true },
    referenceType: { type: String, required: true },
    referenceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    revenue: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },
    profit: { type: Number, required: true },
    date: { type: Date, default: Date.now },
    description: { type: String }
  },
  { timestamps: true }
);

transactionSchema.index({ companyId: 1, type: 1, date: -1 });
transactionSchema.index({ companyId: 1, date: -1 });
transactionSchema.index({ companyId: 1, referenceType: 1, referenceId: 1 });

transactionSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Transaction', transactionSchema);
