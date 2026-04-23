const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

/** Links a settlement payment to specific distributor-clearing ledger DR lines (FIFO) */
const settlementAllocationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    settlementId: { type: mongoose.Schema.Types.ObjectId, ref: 'Settlement', required: true },
    distributorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Distributor', required: true },
    ledgerEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ledger', required: true },
    amount: { type: Number, required: true }
  },
  { timestamps: true }
);

settlementAllocationSchema.index({ companyId: 1, settlementId: 1 });
settlementAllocationSchema.index({ companyId: 1, ledgerEntryId: 1 });

settlementAllocationSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('SettlementAllocation', settlementAllocationSchema);
