const CompanyTaxConfig = require('../../models/CompanyTaxConfig');
const TaxRule = require('../../models/TaxRule');
const Company = require('../../models/Company');
const Pharmacy = require('../../models/Pharmacy');
const ApiError = require('../../utils/ApiError');
const {
  listTaxTypeCodes,
  TAX_TYPE_CODES,
  CALCULATION_BASE,
  TAX_ACCOUNT_CODES,
  PHARMACY_TAX_STATUS,
  TAX_APPLIES_TO,
  TAX_POSTING_BEHAVIOR,
  CALCULATION_METHOD
} = require('../../constants/taxCatalog');
const taxEngine = require('./taxEngine.service');
const auditService = require('../audit.service');
const { startOfUtcDay } = taxEngine;

const assertNoRateOverlap = (rateVersions) => {
  const sorted = [...(rateVersions || [])].sort(
    (a, b) => new Date(a.effectiveFrom) - new Date(b.effectiveFrom)
  );
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const aFrom = startOfUtcDay(a.effectiveFrom).getTime();
    const aTo = a.effectiveTo == null ? Infinity : startOfUtcDay(a.effectiveTo).getTime();
    if (aTo < aFrom) throw new ApiError(400, 'rateVersion effectiveTo must be >= effectiveFrom');
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      const bFrom = startOfUtcDay(b.effectiveFrom).getTime();
      const bTo = b.effectiveTo == null ? Infinity : startOfUtcDay(b.effectiveTo).getTime();
      if (aFrom <= bTo && bFrom <= aTo) {
        throw new ApiError(400, 'rateVersions date ranges must not overlap');
      }
    }
  }
};

const validateExecutionOrderDeps = (executionOrder, rules) => {
  const orderIndex = Object.fromEntries((executionOrder || []).map((c, i) => [c, i]));
  for (const rule of rules || []) {
    if (
      (rule.calculationBase === CALCULATION_BASE.AFTER_TAX_TYPE ||
        rule.calculationBase === CALCULATION_BASE.BEFORE_TAX_TYPE) &&
      rule.calculationBaseTaxTypeCode
    ) {
      const dep = rule.calculationBaseTaxTypeCode;
      const self = rule.taxTypeCode;
      if (orderIndex[dep] == null || orderIndex[self] == null || orderIndex[dep] >= orderIndex[self]) {
        throw new ApiError(
          400,
          `executionOrder: ${self} depends on ${dep} which must appear earlier`
        );
      }
    }
  }
};

const getOrCreateConfig = async (companyId, reqUser) => {
  let config = await CompanyTaxConfig.findOne({ companyId, isDeleted: { $ne: true } });
  if (config) return config;

  const company = await Company.findById(companyId).select('currency country').lean();
  const currency = company?.currency || 'PKR';
  let countryCode = 'PK';
  if (company?.country) {
    const c = String(company.country).toLowerCase();
    if (c.includes('pakistan') || c === 'pk') countryCode = 'PK';
    else if (c.includes('uae') || c.includes('emirates') || c === 'ae') countryCode = 'AE';
    else if (c.includes('saudi') || c === 'sa') countryCode = 'SA';
  }

  config = await CompanyTaxConfig.create({
    companyId,
    enabled: false,
    countryCode,
    currency,
    executionOrder: [],
    createdBy: reqUser?.userId || null,
    updatedBy: reqUser?.userId || null
  });
  return config;
};

const getConfig = async (companyId, reqUser) => {
  const config = await getOrCreateConfig(companyId, reqUser);
  return config.toObject ? config.toObject() : config;
};

const updateConfig = async (companyId, body, reqUser) => {
  const config = await getOrCreateConfig(companyId, reqUser);
  const allowed = [
    'enabled',
    'countryCode',
    'currency',
    'taxYear',
    'rounding',
    'defaultBehaviour',
    'executionOrder',
    'printDefaults'
  ];
  for (const key of allowed) {
    if (body[key] !== undefined) config[key] = body[key];
  }
  if (Array.isArray(config.executionOrder)) {
    const known = new Set(listTaxTypeCodes());
    for (const code of config.executionOrder) {
      if (!known.has(code)) throw new ApiError(400, `Unknown tax type in executionOrder: ${code}`);
    }
  }
  const rules = await TaxRule.find({ companyId, isActive: true, isDeleted: { $ne: true } }).lean();
  validateExecutionOrderDeps(config.executionOrder, rules);
  config.updatedBy = reqUser?.userId || null;
  await config.save();
  await auditService.log({
    companyId,
    userId: reqUser?.userId || null,
    action: 'TAX_CONFIG_CHANGED',
    entityType: 'CompanyTaxConfig',
    entityId: config._id,
    changes: body
  });
  return config.toObject();
};

const listCatalog = () =>
  listTaxTypeCodes().map((code) => ({
    code,
    ...TAX_TYPE_CODES[code]
  }));

const listRules = async (companyId, query = {}) => {
  const filter = { companyId, isDeleted: { $ne: true } };
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true' || query.isActive === true;
  if (query.taxTypeCode) filter.taxTypeCode = query.taxTypeCode;
  return TaxRule.find(filter).sort({ priority: 1, taxTypeCode: 1 }).lean();
};

const createRule = async (companyId, body, reqUser) => {
  assertNoRateOverlap(body.rateVersions);
  if (
    (body.calculationBase === CALCULATION_BASE.AFTER_TAX_TYPE ||
      body.calculationBase === CALCULATION_BASE.BEFORE_TAX_TYPE) &&
    !body.calculationBaseTaxTypeCode
  ) {
    throw new ApiError(400, 'calculationBaseTaxTypeCode is required for this base');
  }
  const rateVersions = (body.rateVersions || []).map((rv) => ({
    ...rv,
    createdBy: reqUser?.userId || null,
    createdAt: new Date()
  }));
  const rule = await TaxRule.create({
    companyId,
    taxTypeCode: body.taxTypeCode,
    name: body.name,
    description: body.description || '',
    sectionCode: body.sectionCode || '',
    calculationMethod: body.calculationMethod || CALCULATION_METHOD.PERCENTAGE,
    calculationBase: body.calculationBase || CALCULATION_BASE.NET_PAYABLE,
    calculationBaseTaxTypeCode: body.calculationBaseTaxTypeCode || null,
    appliesTo: body.appliesTo || TAX_APPLIES_TO.ALL,
    condition: body.condition || {},
    postingBehavior: body.postingBehavior || TAX_POSTING_BEHAVIOR.ADD_TO_RECEIVABLE,
    liabilityAccountCode: body.liabilityAccountCode,
    priority: body.priority ?? 100,
    isActive: body.isActive !== false,
    rateVersions,
    createdBy: reqUser?.userId || null,
    updatedBy: reqUser?.userId || null
  });
  await auditService.log({
    companyId,
    userId: reqUser?.userId || null,
    action: 'TAX_RULE_CHANGED',
    entityType: 'TaxRule',
    entityId: rule._id,
    changes: { action: 'created', taxTypeCode: rule.taxTypeCode, name: rule.name }
  });
  return rule.toObject();
};

const updateRule = async (companyId, ruleId, body, reqUser) => {
  const rule = await TaxRule.findOne({ _id: ruleId, companyId, isDeleted: { $ne: true } });
  if (!rule) throw new ApiError(404, 'Tax rule not found');

  const fields = [
    'name',
    'description',
    'sectionCode',
    'calculationMethod',
    'calculationBase',
    'calculationBaseTaxTypeCode',
    'appliesTo',
    'condition',
    'postingBehavior',
    'liabilityAccountCode',
    'priority',
    'isActive',
    'taxTypeCode'
  ];
  for (const f of fields) {
    if (body[f] !== undefined) rule[f] = body[f];
  }
  if (body.rateVersions !== undefined) {
    assertNoRateOverlap(body.rateVersions);
    rule.rateVersions = body.rateVersions.map((rv) => ({
      ...rv,
      createdBy: rv.createdBy || reqUser?.userId || null,
      createdAt: rv.createdAt || new Date()
    }));
  }
  rule.updatedBy = reqUser?.userId || null;
  await rule.save();

  const config = await CompanyTaxConfig.findOne({ companyId, isDeleted: { $ne: true } }).lean();
  if (config?.executionOrder?.length) {
    const rules = await TaxRule.find({ companyId, isActive: true, isDeleted: { $ne: true } }).lean();
    validateExecutionOrderDeps(config.executionOrder, rules);
  }
  await auditService.log({
    companyId,
    userId: reqUser?.userId || null,
    action: 'TAX_RULE_CHANGED',
    entityType: 'TaxRule',
    entityId: rule._id,
    changes: { action: 'updated', ...body }
  });
  return rule.toObject();
};

const deleteRule = async (companyId, ruleId, reqUser) => {
  const rule = await TaxRule.findOne({ _id: ruleId, companyId, isDeleted: { $ne: true } });
  if (!rule) throw new ApiError(404, 'Tax rule not found');
  rule.isDeleted = true;
  rule.deletedAt = new Date();
  rule.deletedBy = reqUser?.userId || null;
  rule.isActive = false;
  await rule.save();
  await auditService.log({
    companyId,
    userId: reqUser?.userId || null,
    action: 'TAX_RULE_CHANGED',
    entityType: 'TaxRule',
    entityId: rule._id,
    changes: { action: 'deactivated' }
  });
};

const preview = async (companyId, body) => {
  const pharmacy = body.pharmacyId
    ? await Pharmacy.findOne({ _id: body.pharmacyId, companyId, isDeleted: { $ne: true } }).lean()
    : {
        taxStatus: body.taxStatus || PHARMACY_TAX_STATUS.FILER,
        taxExempt: Boolean(body.taxExempt),
        taxExemptReason: body.taxExemptReason || '',
        licenseNumber: body.licenseNumber || '',
        ntn: body.ntn || '',
        strn: body.strn || '',
        taxIdentifiers: body.taxIdentifiers
      };

  if (body.pharmacyId && !pharmacy) throw new ApiError(404, 'Pharmacy not found');

  const netPayable = Number(body.netPayable ?? body.goodsNetPayable ?? 0);
  return taxEngine.calculate({
    companyId,
    businessDate: body.businessDate ? new Date(body.businessDate) : new Date(),
    pharmacy,
    amounts: {
      grossAmount: Number(body.grossAmount ?? netPayable),
      subtotal: Number(body.subtotal ?? body.grossAmount ?? netPayable),
      afterDiscount: Number(body.afterDiscount ?? netPayable),
      netPayable
    }
  });
};

/**
 * Seed Pakistan Advance Tax §236H rules (Filer 0.5% / Non-Filer 2.5%).
 * Idempotent — skips creating duplicates by name+taxTypeCode+taxStatus.
 */
const seedPakistanAdvanceTaxPack = async (companyId, reqUser) => {
  const config = await getOrCreateConfig(companyId, reqUser);
  config.countryCode = 'PK';
  config.currency = config.currency || 'PKR';
  config.executionOrder = ['ADVANCE_TAX_236H'];
  config.taxYear = {
    mode: 'CUSTOM',
    startMonth: 7,
    label: config.taxYear?.label || ''
  };
  config.updatedBy = reqUser?.userId || null;
  await config.save();

  const existing = await TaxRule.find({
    companyId,
    taxTypeCode: 'ADVANCE_TAX_236H',
    isDeleted: { $ne: true }
  }).lean();

  const hasFiler = existing.some((r) => r.condition?.taxStatus === PHARMACY_TAX_STATUS.FILER);
  const hasNonFiler = existing.some((r) => r.condition?.taxStatus === PHARMACY_TAX_STATUS.NON_FILER);

  const effectiveFrom = new Date(Date.UTC(2000, 0, 1));
  const created = [];

  if (!hasFiler) {
    created.push(
      await createRule(
        companyId,
        {
          taxTypeCode: 'ADVANCE_TAX_236H',
          name: 'Advance Tax 236H — Filer',
          description: 'Advance Tax Under Section 236H (Filer)',
          sectionCode: '236H',
          calculationMethod: CALCULATION_METHOD.PERCENTAGE,
          calculationBase: CALCULATION_BASE.NET_PAYABLE,
          appliesTo: TAX_APPLIES_TO.BY_TAX_STATUS,
          condition: { taxStatus: PHARMACY_TAX_STATUS.FILER },
          postingBehavior: TAX_POSTING_BEHAVIOR.ADD_TO_RECEIVABLE,
          liabilityAccountCode: TAX_ACCOUNT_CODES.ADVANCE_TAX_PAYABLE,
          priority: 10,
          rateVersions: [
            {
              ratePercent: 0.5,
              effectiveFrom,
              effectiveTo: null,
              reason: 'Pakistan FBR Advance Tax 236H Filer'
            }
          ]
        },
        reqUser
      )
    );
  }

  if (!hasNonFiler) {
    created.push(
      await createRule(
        companyId,
        {
          taxTypeCode: 'ADVANCE_TAX_236H',
          name: 'Advance Tax 236H — Non-Filer',
          description: 'Advance Tax Under Section 236H (Non-Filer)',
          sectionCode: '236H',
          calculationMethod: CALCULATION_METHOD.PERCENTAGE,
          calculationBase: CALCULATION_BASE.NET_PAYABLE,
          appliesTo: TAX_APPLIES_TO.BY_TAX_STATUS,
          condition: { taxStatus: PHARMACY_TAX_STATUS.NON_FILER },
          postingBehavior: TAX_POSTING_BEHAVIOR.ADD_TO_RECEIVABLE,
          liabilityAccountCode: TAX_ACCOUNT_CODES.ADVANCE_TAX_PAYABLE,
          priority: 10,
          rateVersions: [
            {
              ratePercent: 2.5,
              effectiveFrom,
              effectiveTo: null,
              reason: 'Pakistan FBR Advance Tax 236H Non-Filer'
            }
          ]
        },
        reqUser
      )
    );
  }

  // Ensure COA liability account exists
  const coaEnsure = require('./taxCoa.service');
  await coaEnsure.ensureTaxLiabilityAccounts(companyId, reqUser);

  return {
    config: config.toObject(),
    createdRules: created.length,
    rules: await listRules(companyId)
  };
};

module.exports = {
  getConfig,
  updateConfig,
  listCatalog,
  listRules,
  createRule,
  updateRule,
  deleteRule,
  preview,
  seedPakistanAdvanceTaxPack,
  assertNoRateOverlap
};
