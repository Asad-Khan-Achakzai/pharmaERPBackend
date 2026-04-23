const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const distributorSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    discountOnTP: { type: Number, default: 0 },
    /** % of TP×qty for distributor commission (clearing). Defaults to discountOnTP if unset. */
    commissionPercentOnTP: { type: Number, default: null },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

distributorSchema.index({ companyId: 1, isActive: 1 });

distributorSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Distributor', distributorSchema);
