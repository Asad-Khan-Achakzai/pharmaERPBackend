const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');
const {
  MISSING_TAX_STATUS_BEHAVIOUR,
  TAX_YEAR_MODE,
  TAX_ROUNDING_STRATEGY,
  listTaxTypeCodes
} = require('../constants/taxCatalog');

const taxYearSchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      enum: Object.values(TAX_YEAR_MODE),
      default: TAX_YEAR_MODE.CALENDAR
    },
    startMonth: { type: Number, min: 1, max: 12, default: 1 },
    label: { type: String, trim: true, maxlength: 64, default: '' }
  },
  { _id: false }
);

const roundingSchema = new mongoose.Schema(
  {
    strategy: {
      type: String,
      enum: Object.values(TAX_ROUNDING_STRATEGY),
      default: TAX_ROUNDING_STRATEGY.ROUND_HALF_UP_PKR
    },
    decimalPrecision: { type: Number, min: 0, max: 6, default: 2 }
  },
  { _id: false }
);

const defaultBehaviourSchema = new mongoose.Schema(
  {
    missingTaxStatus: {
      type: String,
      enum: Object.values(MISSING_TAX_STATUS_BEHAVIOUR),
      default: MISSING_TAX_STATUS_BEHAVIOUR.BLOCK
    },
    taxExemptSkipsAll: { type: Boolean, default: true },
    /** On AR write-off: keep govt liability (default) or reverse it. */
    writeOffTaxPolicy: {
      type: String,
      enum: ['KEEP_LIABILITY', 'REVERSE_LIABILITY'],
      default: 'KEEP_LIABILITY'
    }
  },
  { _id: false }
);

const printDefaultsSchema = new mongoose.Schema(
  {
    showLicense: { type: Boolean, default: true },
    showNtn: { type: Boolean, default: true },
    showStrn: { type: Boolean, default: true },
    showTaxBreakdown: { type: Boolean, default: true }
  },
  { _id: false }
);

const companyTaxConfigSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      unique: true
    },
    /** Master switch — false keeps legacy delivery/AR/GL behaviour. */
    enabled: { type: Boolean, default: false },
    countryCode: { type: String, trim: true, uppercase: true, maxlength: 8, default: 'PK' },
    currency: { type: String, trim: true, uppercase: true, maxlength: 8, default: 'PKR' },
    taxYear: { type: taxYearSchema, default: () => ({}) },
    rounding: { type: roundingSchema, default: () => ({}) },
    defaultBehaviour: { type: defaultBehaviourSchema, default: () => ({}) },
    /** Ordered tax type codes applied by the tax engine. */
    executionOrder: {
      type: [String],
      default: [],
      validate: {
        validator(arr) {
          if (!Array.isArray(arr)) return false;
          const known = new Set(listTaxTypeCodes());
          return arr.every((c) => known.has(String(c)));
        },
        message: 'executionOrder contains unknown tax type code'
      }
    },
    printDefaults: { type: printDefaultsSchema, default: () => ({}) }
  },
  { timestamps: true }
);

companyTaxConfigSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('CompanyTaxConfig', companyTaxConfigSchema);
