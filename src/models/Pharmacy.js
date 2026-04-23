const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const pharmacySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    discountOnTP: { type: Number, default: 0 },
    bonusScheme: {
      buyQty: { type: Number, default: 0 },
      getQty: { type: Number, default: 0 }
    },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

pharmacySchema.index({ companyId: 1, isActive: 1 });
pharmacySchema.index({ companyId: 1, name: 1 });

pharmacySchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Pharmacy', pharmacySchema);
