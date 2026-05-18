const Joi = require('joi');
const { ONBOARDING_STEP, IMPORT_MODE, IMPORT_JOB_STATUS } = require('../constants/onboarding');
const { ENTITY_CONFIG } = require('../services/onboardingMasterImport.service');

const startOnboardingSchema = Joi.object({
  currentStep: Joi.string()
    .valid(...Object.values(ONBOARDING_STEP))
    .optional(),
  metadata: Joi.object().unknown(true).optional()
});

const updateOnboardingStepSchema = Joi.object({
  step: Joi.string()
    .valid(...Object.values(ONBOARDING_STEP))
    .required(),
  status: Joi.string().valid('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED').required(),
  note: Joi.string().allow('').max(500).optional(),
  currentStep: Joi.string()
    .valid(...Object.values(ONBOARDING_STEP))
    .optional()
});

const queueImportJobSchema = Joi.object({
  entityType: Joi.string()
    .valid(
      'products',
      'doctors',
      'pharmacies',
      'distributors',
      'employees',
      'territories',
      'openingStock',
      'openingBalances',
      'salesHistory',
      'returnsHistory',
      'collectionsHistory',
      'visitsHistory',
      'targetsHistory'
    )
    .required(),
  mode: Joi.string()
    .valid(...Object.values(IMPORT_MODE))
    .default(IMPORT_MODE.DRY_RUN),
  idempotencyKey: Joi.string().trim().max(200).allow('', null),
  file: Joi.object({
    originalName: Joi.string().allow('', null),
    storageKey: Joi.string().allow('', null),
    mimeType: Joi.string().allow('', null),
    sizeBytes: Joi.number().integer().min(0)
  })
    .unknown(false)
    .default({}),
  mapping: Joi.object().unknown(true).default({}),
  options: Joi.object().unknown(true).default({})
});

const supportedMasterEntities = Object.keys(ENTITY_CONFIG);

const previewMasterImportSchema = Joi.object({
  entityType: Joi.string()
    .valid(...supportedMasterEntities)
    .required(),
  fileBase64: Joi.string().required(),
  sheet: Joi.string().allow('', null)
});

const commitMasterImportSchema = Joi.object({
  entityType: Joi.string()
    .valid(...supportedMasterEntities)
    .required(),
  fileBase64: Joi.string().required(),
  sheet: Joi.string().allow('', null),
  mapping: Joi.object().required(),
  mode: Joi.string()
    .valid(...Object.values(IMPORT_MODE))
    .default(IMPORT_MODE.DRY_RUN),
  skipDuplicates: Joi.boolean().default(true),
  options: Joi.object({
    allowOverwrite: Joi.boolean().default(false)
  })
    .unknown(true)
    .default({})
});

const listImportJobsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(200),
  sortBy: Joi.string().trim().allow(''),
  sortOrder: Joi.string().valid('asc', 'desc'),
  entityType: Joi.string().trim().allow(''),
  status: Joi.string()
    .valid(...Object.values(IMPORT_JOB_STATUS))
    .allow(''),
  onboardingSessionId: Joi.string().hex().length(24).allow('')
});

const listReconciliationsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(200),
  sortBy: Joi.string().trim().allow(''),
  sortOrder: Joi.string().valid('asc', 'desc'),
  entityType: Joi.string().trim().allow(''),
  status: Joi.string().valid('MATCHED', 'MISMATCHED', 'REVIEW_REQUIRED').allow('')
});

const historicalEntitySchema = Joi.string().valid(
  'salesHistory',
  'returnsHistory',
  'collectionsHistory',
  'visitsHistory',
  'targetsHistory'
);

const previewHistoricalImportSchema = Joi.object({
  entityType: historicalEntitySchema.required(),
  fileBase64: Joi.string().required(),
  sheet: Joi.string().allow('', null),
  fromDate: Joi.string().required(),
  toDate: Joi.string().required()
});

const archiveHistoricalImportSchema = Joi.object({
  entityType: historicalEntitySchema.required(),
  fileBase64: Joi.string().required(),
  sheet: Joi.string().allow('', null),
  fromDate: Joi.string().required(),
  toDate: Joi.string().required(),
  archiveMode: Joi.string().valid('ARCHIVE_ONLY', 'ARCHIVE_PLUS_SUMMARY').default('ARCHIVE_ONLY'),
  file: Joi.object({
    originalName: Joi.string().allow('', null),
    mimeType: Joi.string().allow('', null),
    sizeBytes: Joi.number().integer().min(0)
  })
    .unknown(true)
    .default({})
});

const listHistoricalArchivesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(200),
  sortBy: Joi.string().trim().allow(''),
  sortOrder: Joi.string().valid('asc', 'desc'),
  entityType: historicalEntitySchema.allow('')
});

const rollbackImportJobSchema = Joi.object({
  reason: Joi.string().trim().allow('').max(500)
});

module.exports = {
  startOnboardingSchema,
  updateOnboardingStepSchema,
  queueImportJobSchema,
  previewMasterImportSchema,
  commitMasterImportSchema,
  listImportJobsQuerySchema,
  listReconciliationsQuerySchema,
  previewHistoricalImportSchema,
  archiveHistoricalImportSchema,
  listHistoricalArchivesQuerySchema,
  rollbackImportJobSchema
};
