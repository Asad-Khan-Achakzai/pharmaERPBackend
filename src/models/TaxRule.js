const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');
const {
  CALCULATION_BASE,
  CALCULATION_METHOD,
  TAX_APPLIES_TO,
  TAX_POSTING_BEHAVIOR,
  PHARMACY_TAX_STATUS,
  listTaxTypeCodes
} = require('../constants/taxCatalog');

const rateTierSchema = new mongoose.Schema(
  {
    upTo: { type: Number, required: true },
    ratePercent: { type: Number, required: true }
  },
  { _id: false }
);

const rateVersionSchema = new mongoose.Schema(
  {
    ratePercent: { type: Number, default: null },
    fixedAmount: { type: Number, default: null },
    tiers: { type: [rateTierSchema], default: undefined },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
    reason: { type: String, trim: true, maxlength: 500, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const taxRuleConditionSchema = new mongoose.Schema(
  {
    taxStatus: {
      type: String,
      enum: Object.values(PHARMACY_TAX_STATUS),
      default: undefined
    },
    attributes: { type: mongoose.Schema.Types.Mixed, default: undefined }
  },
  { _id: false }
);

const taxRuleSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    taxTypeCode: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator(v) {
          return listTaxTypeCodes().includes(String(v));
        },
        message: 'Unknown taxTypeCode'
      }
    },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    sectionCode: { type: String, trim: true, maxlength: 64, default: '' },
    calculationMethod: {
      type: String,
      enum: Object.values(CALCULATION_METHOD),
      default: CALCULATION_METHOD.PERCENTAGE
    },
    calculationBase: {
      type: String,
      enum: Object.values(CALCULATION_BASE),
      default: CALCULATION_BASE.NET_PAYABLE
    },
    calculationBaseTaxTypeCode: { type: String, trim: true, default: null },
    appliesTo: {
      type: String,
      enum: Object.values(TAX_APPLIES_TO),
      default: TAX_APPLIES_TO.ALL
    },
    condition: { type: taxRuleConditionSchema, default: () => ({}) },
    postingBehavior: {
      type: String,
      enum: Object.values(TAX_POSTING_BEHAVIOR),
      default: TAX_POSTING_BEHAVIOR.ADD_TO_RECEIVABLE
    },
    liabilityAccountCode: { type: String, trim: true, maxlength: 32, required: true },
    priority: { type: Number, default: 100, min: 0 },
    isActive: { type: Boolean, default: true },
    rateVersions: { type: [rateVersionSchema], default: [] }
  },
  { timestamps: true }
);

taxRuleSchema.index({ companyId: 1, taxTypeCode: 1, isActive: 1 });
taxRuleSchema.index({ companyId: 1, isActive: 1, priority: 1 });

taxRuleSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('TaxRule', taxRuleSchema);
