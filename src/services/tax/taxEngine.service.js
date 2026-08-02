const CompanyTaxConfig = require('../../models/CompanyTaxConfig');
const TaxRule = require('../../models/TaxRule');
const ApiError = require('../../utils/ApiError');
const { roundPKR } = require('../../utils/currency');
const {
  CALCULATION_BASE,
  CALCULATION_METHOD,
  TAX_APPLIES_TO,
  TAX_POSTING_BEHAVIOR,
  PHARMACY_TAX_STATUS,
  MISSING_TAX_STATUS_BEHAVIOUR,
  TAX_ENGINE_VERSION,
  TAX_POSTING_VERSION,
  getTaxTypeMeta,
  TAX_CATEGORY
} = require('../../constants/taxCatalog');

const startOfUtcDay = (d) => {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
};

/**
 * Pick rate version covering businessDate (inclusive from, inclusive/null to).
 */
const resolveRateVersion = (rateVersions, businessDate) => {
  const day = startOfUtcDay(businessDate).getTime();
  const matches = (rateVersions || []).filter((rv) => {
    const from = startOfUtcDay(rv.effectiveFrom).getTime();
    if (day < from) return false;
    if (rv.effectiveTo == null) return true;
    return day <= startOfUtcDay(rv.effectiveTo).getTime();
  });
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    matches.sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom));
  }
  return matches[0];
};

const ruleMatchesPharmacy = (rule, pharmacy, resolvedStatus) => {
  if (rule.appliesTo === TAX_APPLIES_TO.ALL) return true;
  if (rule.appliesTo === TAX_APPLIES_TO.BY_TAX_STATUS) {
    const want = rule.condition?.taxStatus;
    if (!want) return true;
    return String(resolvedStatus) === String(want);
  }
  if (rule.appliesTo === TAX_APPLIES_TO.BY_ATTRIBUTE) {
    const attrs = rule.condition?.attributes || {};
    const phAttrs = pharmacy?.taxIdentifiers || {};
    return Object.entries(attrs).every(([k, v]) => String(phAttrs[k]) === String(v));
  }
  return false;
};

const resolvePharmacyStatus = (pharmacy, config) => {
  let status = pharmacy?.taxStatus || PHARMACY_TAX_STATUS.UNKNOWN;
  if (
    status === PHARMACY_TAX_STATUS.UNKNOWN ||
    status === PHARMACY_TAX_STATUS.NOT_APPLICABLE
  ) {
    const behaviour = config.defaultBehaviour?.missingTaxStatus || MISSING_TAX_STATUS_BEHAVIOUR.BLOCK;
    if (behaviour === MISSING_TAX_STATUS_BEHAVIOUR.TREAT_AS_FILER) {
      return { status: PHARMACY_TAX_STATUS.FILER, blocked: false };
    }
    if (behaviour === MISSING_TAX_STATUS_BEHAVIOUR.TREAT_AS_NON_FILER) {
      return { status: PHARMACY_TAX_STATUS.NON_FILER, blocked: false };
    }
    return { status, blocked: true };
  }
  return { status, blocked: false };
};

const resolveBaseAmount = (base, baseTaxTypeCode, amounts, workingAfterTax, workingBeforeTax) => {
  switch (base) {
    case CALCULATION_BASE.GROSS_AMOUNT:
      return roundPKR(amounts.grossAmount || 0);
    case CALCULATION_BASE.SUBTOTAL:
      return roundPKR(amounts.subtotal ?? amounts.grossAmount ?? 0);
    case CALCULATION_BASE.AFTER_DISCOUNT:
      return roundPKR(amounts.afterDiscount ?? amounts.netPayable ?? 0);
    case CALCULATION_BASE.NET_PAYABLE:
      return roundPKR(amounts.netPayable || 0);
    case CALCULATION_BASE.AFTER_TAX_TYPE: {
      if (!baseTaxTypeCode) throw new ApiError(400, 'calculationBaseTaxTypeCode required for AFTER_TAX_TYPE');
      if (workingAfterTax[baseTaxTypeCode] == null) {
        throw new ApiError(400, `Tax base AFTER_TAX_TYPE refers to ${baseTaxTypeCode} which has not been applied yet`);
      }
      return roundPKR(workingAfterTax[baseTaxTypeCode]);
    }
    case CALCULATION_BASE.BEFORE_TAX_TYPE: {
      if (!baseTaxTypeCode) throw new ApiError(400, 'calculationBaseTaxTypeCode required for BEFORE_TAX_TYPE');
      if (workingBeforeTax[baseTaxTypeCode] == null) {
        throw new ApiError(400, `Tax base BEFORE_TAX_TYPE refers to ${baseTaxTypeCode} which is unavailable`);
      }
      return roundPKR(workingBeforeTax[baseTaxTypeCode]);
    }
    case CALCULATION_BASE.CUSTOM:
      return roundPKR(amounts.customBase || amounts.netPayable || 0);
    default:
      return roundPKR(amounts.netPayable || 0);
  }
};

const computeTaxAmount = (method, rateVersion, baseAmount) => {
  if (method === CALCULATION_METHOD.FIXED) {
    return roundPKR(rateVersion.fixedAmount || 0);
  }
  if (method === CALCULATION_METHOD.TIERED) {
    const tiers = rateVersion.tiers || [];
    let remaining = baseAmount;
    let tax = 0;
    let prev = 0;
    for (const tier of tiers) {
      const slice = Math.min(remaining, Math.max(0, tier.upTo - prev));
      tax += (slice * (tier.ratePercent || 0)) / 100;
      remaining -= slice;
      prev = tier.upTo;
      if (remaining <= 0) break;
    }
    if (remaining > 0 && tiers.length) {
      const last = tiers[tiers.length - 1];
      tax += (remaining * (last.ratePercent || 0)) / 100;
    }
    return roundPKR(tax);
  }
  // PERCENTAGE
  return roundPKR((baseAmount * (Number(rateVersion.ratePercent) || 0)) / 100);
};

/**
 * Pure calculation (loads config/rules from DB). No Ledger/GL/Register writes.
 *
 * @returns {{ enabled: boolean, lines: object[], taxTotal: number, invoiceGrandTotal: number, meta: object }}
 */
const calculate = async ({
  companyId,
  businessDate,
  pharmacy,
  amounts,
  session = null
} = {}) => {
  const goods = roundPKR(amounts?.netPayable ?? 0);
  const empty = {
    enabled: false,
    lines: [],
    taxTotal: 0,
    invoiceGrandTotal: goods,
    meta: {
      engineVersion: TAX_ENGINE_VERSION,
      postingVersion: TAX_POSTING_VERSION,
      executionOrderApplied: [],
      countryCode: '',
      currency: '',
      pharmacyTaxStatus: pharmacy?.taxStatus || '',
      taxExempt: Boolean(pharmacy?.taxExempt)
    }
  };

  const config = await CompanyTaxConfig.findOne({ companyId, isDeleted: { $ne: true } })
    .session(session || null)
    .lean();

  if (!config || !config.enabled) {
    return empty;
  }

  if (pharmacy?.taxExempt && config.defaultBehaviour?.taxExemptSkipsAll !== false) {
    return {
      ...empty,
      enabled: true,
      meta: {
        ...empty.meta,
        countryCode: config.countryCode || '',
        currency: config.currency || '',
        taxExempt: true,
        taxExemptReason: pharmacy.taxExemptReason || ''
      }
    };
  }

  const needsStatusRules = true; // validated per matching rule below
  const { status: resolvedStatus, blocked } = resolvePharmacyStatus(pharmacy, config);

  const rules = await TaxRule.find({ companyId, isActive: true, isDeleted: { $ne: true } })
    .session(session || null)
    .lean();

  const executionOrder =
    Array.isArray(config.executionOrder) && config.executionOrder.length
      ? config.executionOrder
      : [...new Set(rules.map((r) => r.taxTypeCode))];

  // Validate AFTER/BEFORE dependencies vs order
  const orderIndex = Object.fromEntries(executionOrder.map((c, i) => [c, i]));

  const amt = {
    grossAmount: roundPKR(amounts?.grossAmount || 0),
    subtotal: roundPKR(amounts?.subtotal ?? amounts?.grossAmount ?? 0),
    afterDiscount: roundPKR(amounts?.afterDiscount ?? goods),
    netPayable: goods,
    customBase: amounts?.customBase
  };

  let runningPayable = goods;
  const workingAfterTax = {};
  const workingBeforeTax = {};
  const lines = [];
  let sequence = 0;
  let additive = 0;
  let withholding = 0;
  let statusBlockedHit = false;

  for (const taxTypeCode of executionOrder) {
    workingBeforeTax[taxTypeCode] = runningPayable;

    const typeRules = rules
      .filter((r) => r.taxTypeCode === taxTypeCode)
      .filter((r) => ruleMatchesPharmacy(r, pharmacy, resolvedStatus))
      .sort((a, b) => (a.priority || 100) - (b.priority || 100));

    if (
      typeRules.some((r) => r.appliesTo === TAX_APPLIES_TO.BY_TAX_STATUS) &&
      blocked
    ) {
      statusBlockedHit = true;
      break;
    }

    for (const rule of typeRules) {
      if (
        (rule.calculationBase === CALCULATION_BASE.AFTER_TAX_TYPE ||
          rule.calculationBase === CALCULATION_BASE.BEFORE_TAX_TYPE) &&
        rule.calculationBaseTaxTypeCode
      ) {
        const dep = rule.calculationBaseTaxTypeCode;
        if (orderIndex[dep] == null || orderIndex[dep] >= orderIndex[taxTypeCode]) {
          throw new ApiError(
            400,
            `Tax rule "${rule.name}" base depends on ${dep} which must appear earlier in executionOrder`
          );
        }
      }

      const rateVersion = resolveRateVersion(rule.rateVersions, businessDate || new Date());
      if (!rateVersion) {
        throw new ApiError(
          400,
          `No tax rate schedule covers this date for rule "${rule.name}" (${taxTypeCode})`
        );
      }

      const baseAmount = resolveBaseAmount(
        rule.calculationBase,
        rule.calculationBaseTaxTypeCode,
        amt,
        workingAfterTax,
        workingBeforeTax
      );
      const taxAmount = computeTaxAmount(rule.calculationMethod, rateVersion, baseAmount);
      const meta = getTaxTypeMeta(taxTypeCode);
      sequence += 1;

      const behavior = rule.postingBehavior || TAX_POSTING_BEHAVIOR.ADD_TO_RECEIVABLE;
      if (behavior === TAX_POSTING_BEHAVIOR.ADD_TO_RECEIVABLE) {
        additive = roundPKR(additive + taxAmount);
        runningPayable = roundPKR(runningPayable + taxAmount);
      } else if (behavior === TAX_POSTING_BEHAVIOR.DEDUCT_FROM_RECEIVABLE) {
        withholding = roundPKR(withholding + taxAmount);
        runningPayable = roundPKR(runningPayable - taxAmount);
      }

      const section = rule.sectionCode || meta?.defaultSection || '';
      const ratePct = rateVersion.ratePercent != null ? Number(rateVersion.ratePercent) : null;
      const desc =
        rule.description ||
        (ratePct != null
          ? `${meta?.label || taxTypeCode}${section ? ` (${section})` : ''} @ ${ratePct}%`
          : meta?.label || taxTypeCode);

      lines.push({
        sequence,
        taxTypeCode,
        taxTypeName: meta?.label || taxTypeCode,
        taxSection: section,
        taxDescription: desc,
        calculationBase: rule.calculationBase,
        calculationBaseAmount: baseAmount,
        ratePercent: ratePct,
        taxAmount,
        postingBehavior: behavior,
        liabilityAccountCode: rule.liabilityAccountCode,
        taxRuleId: rule._id,
        rateVersionId: rateVersion._id || null,
        category: meta?.category || TAX_CATEGORY.ADDITIVE
      });
    }

    workingAfterTax[taxTypeCode] = runningPayable;
  }

  if (statusBlockedHit) {
    throw new ApiError(
      400,
      'Pharmacy tax status is required (Filer / Non-Filer) before delivery when tax is enabled'
    );
  }

  // Ignore needsStatusRules lint
  void needsStatusRules;

  const taxTotal = roundPKR(additive - withholding);
  const invoiceGrandTotal = roundPKR(goods + taxTotal);

  return {
    enabled: true,
    lines,
    taxTotal,
    invoiceGrandTotal,
    meta: {
      engineVersion: TAX_ENGINE_VERSION,
      postingVersion: TAX_POSTING_VERSION,
      calculatedAt: new Date(),
      businessDate: businessDate || new Date(),
      executionOrderApplied: executionOrder,
      countryCode: config.countryCode || '',
      currency: config.currency || '',
      pharmacyTaxStatus: resolvedStatus,
      pharmacyLicenseNumber: pharmacy?.licenseNumber || '',
      pharmacyNtn: pharmacy?.ntn || '',
      pharmacyStrn: pharmacy?.strn || '',
      taxExempt: false,
      taxExemptReason: '',
      amounts: {
        goodsNetPayable: goods,
        taxTotal,
        invoiceGrandTotal
      }
    }
  };
};

/**
 * Build DeliveryRecord.taxSnapshot from engine result.
 */
const toDeliverySnapshot = (engineResult) => {
  if (!engineResult?.enabled) return null;
  const m = engineResult.meta || {};
  return {
    engineVersion: m.engineVersion || TAX_ENGINE_VERSION,
    postingVersion: m.postingVersion || TAX_POSTING_VERSION,
    calculatedAt: m.calculatedAt || new Date(),
    businessDate: m.businessDate || new Date(),
    countryCode: m.countryCode || '',
    currency: m.currency || '',
    pharmacyTaxStatus: m.pharmacyTaxStatus || '',
    pharmacyLicenseNumber: m.pharmacyLicenseNumber || '',
    pharmacyNtn: m.pharmacyNtn || '',
    pharmacyStrn: m.pharmacyStrn || '',
    taxExempt: Boolean(m.taxExempt),
    taxExemptReason: m.taxExemptReason || '',
    executionOrderApplied: m.executionOrderApplied || [],
    lines: (engineResult.lines || []).map((l) => ({
      sequence: l.sequence,
      taxTypeCode: l.taxTypeCode,
      taxTypeName: l.taxTypeName,
      taxSection: l.taxSection,
      taxDescription: l.taxDescription,
      calculationBase: l.calculationBase,
      calculationBaseAmount: l.calculationBaseAmount,
      ratePercent: l.ratePercent,
      taxAmount: l.taxAmount,
      postingBehavior: l.postingBehavior,
      liabilityAccountCode: l.liabilityAccountCode,
      taxRuleId: l.taxRuleId,
      rateVersionId: l.rateVersionId
    })),
    amounts: m.amounts || {
      goodsNetPayable: roundPKR(engineResult.invoiceGrandTotal - engineResult.taxTotal),
      taxTotal: engineResult.taxTotal,
      invoiceGrandTotal: engineResult.invoiceGrandTotal
    }
  };
};

module.exports = {
  calculate,
  toDeliverySnapshot,
  resolveRateVersion,
  startOfUtcDay
};
