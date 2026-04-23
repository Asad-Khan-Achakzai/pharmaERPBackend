const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const doctorSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    pharmacyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', required: true },
    name: { type: String, required: true, trim: true },
    specialization: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

doctorSchema.index({ companyId: 1, pharmacyId: 1 });
doctorSchema.index({ companyId: 1, isActive: 1 });

doctorSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Doctor', doctorSchema);
