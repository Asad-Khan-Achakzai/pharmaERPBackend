const mongoose = require('mongoose');
const { Info } = require('luxon');
const { softDeletePlugin } = require('../plugins/softDelete');

const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, default: 'Pakistan' },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    logo: { type: String },
    currency: { type: String, default: 'PKR' },
    /** Starting bank/cash position for implied cash balance (collections + settlements − outflows) */
    cashOpeningBalance: { type: Number, default: 0 },
    /** Single canonical IANA timezone for business calendar (reports, plans, attendance anchors). Required at creation — no implicit UTC. */
    timeZone: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator(v) {
          return Info.isValidIANAZone(String(v || '').trim());
        },
        message: 'Company timeZone must be a valid IANA timezone identifier'
      }
    },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

companySchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Company', companySchema);
