const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');
const { PHARMACY_TAX_STATUS } = require('../constants/taxCatalog');

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
    isActive: { type: Boolean, default: true },
    /** Brick-level Territory ref (MRep). Optional — legacy pharmacies leave this null. */
    territoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Territory', default: null, index: true },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    /** Pharmacy drug license — printable on invoices when present. */
    licenseNumber: { type: String, trim: true, maxlength: 128, default: '' },
    licenseExpiry: { type: Date, default: null },
    licenseAuthority: { type: String, trim: true, maxlength: 200, default: '' },
    /** Pharmacy NTN (customer) — distinct from Company.ntnNo (seller). */
    ntn: { type: String, trim: true, maxlength: 64, default: '' },
    strn: { type: String, trim: true, maxlength: 64, default: '' },
    taxStatus: {
      type: String,
      enum: Object.values(PHARMACY_TAX_STATUS),
      default: PHARMACY_TAX_STATUS.UNKNOWN
    },
    taxExempt: { type: Boolean, default: false },
    taxExemptReason: { type: String, trim: true, maxlength: 500, default: '' },
    /** Country-specific identifiers (VATIN, TIN, CR, province, …). */
    taxIdentifiers: { type: mongoose.Schema.Types.Mixed, default: undefined }
  },
  { timestamps: true }
);

pharmacySchema.index({ companyId: 1, isActive: 1 });
pharmacySchema.index({ companyId: 1, name: 1 });
pharmacySchema.index({ companyId: 1, territoryId: 1, isActive: 1 });
pharmacySchema.index({ companyId: 1, latitude: 1, longitude: 1 });

pharmacySchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Pharmacy', pharmacySchema);
