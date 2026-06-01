const mongoose = require('mongoose');
const { VOUCHER_TYPE } = require('../constants/enums');

const voucherSequenceSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    voucherType: { type: String, enum: Object.values(VOUCHER_TYPE), required: true },
    prefix: { type: String, required: true, trim: true },
    nextNumber: { type: Number, required: true, default: 1 }
  },
  { timestamps: true }
);

voucherSequenceSchema.index({ companyId: 1, voucherType: 1 }, { unique: true });

module.exports = mongoose.model('VoucherSequence', voucherSequenceSchema);
