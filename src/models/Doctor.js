const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const doctorSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    /** Optional — doctors may exist without a linked pharmacy (field-force CRM style). */
    pharmacyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', default: null },
    name: { type: String, required: true, trim: true },
    specialization: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    isActive: { type: Boolean, default: true },
    zone: { type: String, trim: true, maxlength: 120 },
    doctorBrick: { type: String, trim: true, maxlength: 120 },
    doctorCode: { type: String, trim: true, maxlength: 64 },
    qualification: { type: String, trim: true, maxlength: 200 },
    mobileNo: { type: String, trim: true, maxlength: 32 },
    gender: { type: String, trim: true, maxlength: 32 },
    frequency: { type: String, trim: true, maxlength: 120 },
    locationName: { type: String, trim: true, maxlength: 200 },
    address: { type: String, trim: true, maxlength: 500 },
    city: { type: String, trim: true, maxlength: 120 },
    grade: { type: String, trim: true, maxlength: 64 },
    /** PMDC # / duplicate / SMART (single free-text field per tenant practice). */
    pmdcRegistration: { type: String, trim: true, maxlength: 200 },
    designation: { type: String, trim: true, maxlength: 200 },
    patientCount: { type: Number, min: 0, default: null }
  },
  { timestamps: true }
);

doctorSchema.index({ companyId: 1, pharmacyId: 1 });
doctorSchema.index({ companyId: 1, isActive: 1 });

doctorSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Doctor', doctorSchema);
