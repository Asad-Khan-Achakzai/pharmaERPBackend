const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const supplierSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    address: { type: String, trim: true },
    /** Opening balance owed to this supplier (before ledger entries) */
    openingBalance: { type: Number, default: 0 },
    notes: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

supplierSchema.index({ companyId: 1, name: 1 });
supplierSchema.index({ companyId: 1, isActive: 1 });

supplierSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Supplier', supplierSchema);
