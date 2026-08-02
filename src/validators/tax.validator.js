const Joi = require('joi');
const {
  listTaxTypeCodes,
  CALCULATION_BASE,
  CALCULATION_METHOD,
  TAX_APPLIES_TO,
  TAX_POSTING_BEHAVIOR,
  PHARMACY_TAX_STATUS,
  MISSING_TAX_STATUS_BEHAVIOUR,
  TAX_YEAR_MODE,
  TAX_ROUNDING_STRATEGY
} = require('../constants/taxCatalog');

const rateVersionSchema = Joi.object({
  _id: Joi.string().hex().length(24),
  ratePercent: Joi.number().min(0).max(100).allow(null),
  fixedAmount: Joi.number().min(0).allow(null),
  tiers: Joi.array()
    .items(
      Joi.object({
        upTo: Joi.number().required(),
        ratePercent: Joi.number().min(0).max(100).required()
      })
    )
    .optional(),
  effectiveFrom: Joi.date().iso().required(),
  effectiveTo: Joi.date().iso().allow(null),
  reason: Joi.string().trim().allow('').max(500),
  createdBy: Joi.string().hex().length(24).allow(null),
  createdAt: Joi.date().iso()
});

const updateConfigSchema = Joi.object({
  enabled: Joi.boolean(),
  countryCode: Joi.string().trim().uppercase().max(8),
  currency: Joi.string().trim().uppercase().max(8),
  taxYear: Joi.object({
    mode: Joi.string().valid(...Object.values(TAX_YEAR_MODE)),
    startMonth: Joi.number().integer().min(1).max(12),
    label: Joi.string().trim().allow('').max(64)
  }),
  rounding: Joi.object({
    strategy: Joi.string().valid(...Object.values(TAX_ROUNDING_STRATEGY)),
    decimalPrecision: Joi.number().integer().min(0).max(6)
  }),
  defaultBehaviour: Joi.object({
    missingTaxStatus: Joi.string().valid(...Object.values(MISSING_TAX_STATUS_BEHAVIOUR)),
    taxExemptSkipsAll: Joi.boolean(),
    writeOffTaxPolicy: Joi.string().valid('KEEP_LIABILITY', 'REVERSE_LIABILITY')
  }),
  executionOrder: Joi.array().items(Joi.string().valid(...listTaxTypeCodes())),
  printDefaults: Joi.object({
    showLicense: Joi.boolean(),
    showNtn: Joi.boolean(),
    showStrn: Joi.boolean(),
    showTaxBreakdown: Joi.boolean()
  })
}).min(1);

const createRuleSchema = Joi.object({
  taxTypeCode: Joi.string()
    .valid(...listTaxTypeCodes())
    .required(),
  name: Joi.string().trim().min(1).max(200).required(),
  description: Joi.string().trim().allow('').max(1000),
  sectionCode: Joi.string().trim().allow('').max(64),
  calculationMethod: Joi.string().valid(...Object.values(CALCULATION_METHOD)),
  calculationBase: Joi.string().valid(...Object.values(CALCULATION_BASE)),
  calculationBaseTaxTypeCode: Joi.string()
    .valid(...listTaxTypeCodes())
    .allow(null, ''),
  appliesTo: Joi.string().valid(...Object.values(TAX_APPLIES_TO)),
  condition: Joi.object({
    taxStatus: Joi.string()
      .valid(...Object.values(PHARMACY_TAX_STATUS))
      .allow(null),
    attributes: Joi.object().unknown(true)
  }),
  postingBehavior: Joi.string().valid(...Object.values(TAX_POSTING_BEHAVIOR)),
  liabilityAccountCode: Joi.string().trim().max(32).required(),
  priority: Joi.number().integer().min(0),
  isActive: Joi.boolean(),
  rateVersions: Joi.array().items(rateVersionSchema).min(1).required()
});

const updateRuleSchema = createRuleSchema.fork(
  ['taxTypeCode', 'name', 'liabilityAccountCode', 'rateVersions'],
  (s) => s.optional()
).min(1);

const previewSchema = Joi.object({
  pharmacyId: Joi.string().hex().length(24),
  taxStatus: Joi.string().valid(...Object.values(PHARMACY_TAX_STATUS)),
  taxExempt: Joi.boolean(),
  taxExemptReason: Joi.string().trim().allow('').max(500),
  licenseNumber: Joi.string().trim().allow('').max(128),
  ntn: Joi.string().trim().allow('').max(64),
  strn: Joi.string().trim().allow('').max(64),
  taxIdentifiers: Joi.object().unknown(true),
  businessDate: Joi.date().iso(),
  netPayable: Joi.number().min(0),
  goodsNetPayable: Joi.number().min(0),
  grossAmount: Joi.number().min(0),
  subtotal: Joi.number().min(0),
  afterDiscount: Joi.number().min(0)
}).or('netPayable', 'goodsNetPayable');

const remittanceSchema = Joi.object({
  amount: Joi.number().positive().required(),
  moneyAccountId: Joi.string().hex().length(24).required(),
  businessDate: Joi.date().iso(),
  taxTypeCode: Joi.string().valid(...listTaxTypeCodes()),
  registerEntryIds: Joi.array().items(Joi.string().hex().length(24)),
  narration: Joi.string().trim().allow('').max(500),
  governmentAuthority: Joi.string().trim().allow('').max(200)
});

const createDepositSchema = Joi.object({
  governmentAuthority: Joi.string().trim().allow('').max(200),
  taxPeriodFrom: Joi.date().iso().allow(null),
  taxPeriodTo: Joi.date().iso().allow(null),
  paymentDate: Joi.date().iso().allow(null),
  paymentReference: Joi.string().trim().allow('').max(200),
  bankReference: Joi.string().trim().allow('').max(200),
  moneyAccountId: Joi.string().hex().length(24).allow(null, ''),
  notes: Joi.string().trim().allow('').max(2000),
  currency: Joi.string().trim().uppercase().max(8),
  registerEntryIds: Joi.array().items(Joi.string().hex().length(24)),
  /** When true/omitted and registerEntryIds empty, select all OPEN eligible entries. */
  autoSelectAll: Joi.boolean()
});

const updateDepositSchema = createDepositSchema.min(1);

const depositEntriesSchema = Joi.object({
  registerEntryIds: Joi.array().items(Joi.string().hex().length(24)).min(1),
  entryIds: Joi.array().items(Joi.string().hex().length(24)).min(1)
}).or('registerEntryIds', 'entryIds');

const submitDepositSchema = Joi.object({
  moneyAccountId: Joi.string().hex().length(24),
  paymentDate: Joi.date().iso(),
  paymentReference: Joi.string().trim().allow('').max(200),
  bankReference: Joi.string().trim().allow('').max(200),
  governmentAuthority: Joi.string().trim().allow('').max(200),
  narration: Joi.string().trim().allow('').max(500)
});

const attachReceiptSchema = Joi.object({
  mediaAssetId: Joi.string().hex().length(24).required(),
  fileName: Joi.string().trim().allow('').max(255),
  mimeType: Joi.string().trim().allow('').max(128)
});

const cancelDepositSchema = Joi.object({
  reason: Joi.string().trim().allow('').max(500),
  cancelReason: Joi.string().trim().allow('').max(500)
});

const reverseDepositSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(1000),
  reverseReason: Joi.string().trim().min(3).max(1000)
}).or('reason', 'reverseReason');

module.exports = {
  updateConfigSchema,
  createRuleSchema,
  updateRuleSchema,
  previewSchema,
  remittanceSchema,
  createDepositSchema,
  updateDepositSchema,
  depositEntriesSchema,
  submitDepositSchema,
  attachReceiptSchema,
  cancelDepositSchema,
  reverseDepositSchema
};
