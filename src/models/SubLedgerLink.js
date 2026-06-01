const mongoose = require('mongoose');
const { SUB_LEDGER_SOURCE } = require('../constants/enums');

const subLedgerLinkSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    subLedgerSource: { type: String, enum: Object.values(SUB_LEDGER_SOURCE), required: true },
    subLedgerEntryId: { type: mongoose.Schema.Types.ObjectId, required: true },
    voucherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Voucher', required: true },
    voucherLineId: { type: mongoose.Schema.Types.ObjectId, required: true }
  },
  { timestamps: true }
);

subLedgerLinkSchema.index({ companyId: 1, subLedgerSource: 1, subLedgerEntryId: 1 });
subLedgerLinkSchema.index({ companyId: 1, voucherId: 1 });

module.exports = mongoose.model('SubLedgerLink', subLedgerLinkSchema);
