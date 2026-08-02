/**
 * Platform tax type catalog (not a Mongo collection).
 * Stable codes used in snapshots, Tax Register, GL mapping, and exports.
 */

const TAX_CATEGORY = {
  ADDITIVE: 'ADDITIVE',
  WITHHOLDING: 'WITHHOLDING',
  INCLUSIVE: 'INCLUSIVE'
};

const TAX_TYPE_CODES = {
  ADVANCE_TAX_236H: {
    code: 'ADVANCE_TAX_236H',
    category: TAX_CATEGORY.ADDITIVE,
    defaultSection: '236H',
    label: 'Advance Tax u/s 236H'
  },
  VAT: {
    code: 'VAT',
    category: TAX_CATEGORY.ADDITIVE,
    defaultSection: 'VAT',
    label: 'VAT'
  },
  GST: {
    code: 'GST',
    category: TAX_CATEGORY.ADDITIVE,
    defaultSection: 'GST',
    label: 'GST'
  },
  WHT: {
    code: 'WHT',
    category: TAX_CATEGORY.WITHHOLDING,
    defaultSection: 'WHT',
    label: 'Withholding Tax'
  },
  ENVIRONMENTAL: {
    code: 'ENVIRONMENTAL',
    category: TAX_CATEGORY.ADDITIVE,
    defaultSection: 'ENV',
    label: 'Environmental Tax'
  }
};

const CALCULATION_BASE = {
  GROSS_AMOUNT: 'GROSS_AMOUNT',
  SUBTOTAL: 'SUBTOTAL',
  AFTER_DISCOUNT: 'AFTER_DISCOUNT',
  NET_PAYABLE: 'NET_PAYABLE',
  BEFORE_TAX_TYPE: 'BEFORE_TAX_TYPE',
  AFTER_TAX_TYPE: 'AFTER_TAX_TYPE',
  CUSTOM: 'CUSTOM'
};

const CALCULATION_METHOD = {
  PERCENTAGE: 'PERCENTAGE',
  FIXED: 'FIXED',
  TIERED: 'TIERED'
};

const TAX_APPLIES_TO = {
  ALL: 'ALL',
  BY_TAX_STATUS: 'BY_TAX_STATUS',
  BY_ATTRIBUTE: 'BY_ATTRIBUTE'
};

const TAX_POSTING_BEHAVIOR = {
  ADD_TO_RECEIVABLE: 'ADD_TO_RECEIVABLE',
  DEDUCT_FROM_RECEIVABLE: 'DEDUCT_FROM_RECEIVABLE',
  INFO_ONLY: 'INFO_ONLY'
};

const PHARMACY_TAX_STATUS = {
  FILER: 'FILER',
  NON_FILER: 'NON_FILER',
  UNKNOWN: 'UNKNOWN',
  NOT_APPLICABLE: 'NOT_APPLICABLE'
};

const MISSING_TAX_STATUS_BEHAVIOUR = {
  BLOCK: 'BLOCK',
  TREAT_AS_NON_FILER: 'TREAT_AS_NON_FILER',
  TREAT_AS_FILER: 'TREAT_AS_FILER'
};

const TAX_YEAR_MODE = {
  CALENDAR: 'CALENDAR',
  CUSTOM: 'CUSTOM'
};

const TAX_ROUNDING_STRATEGY = {
  ROUND_HALF_UP_PKR: 'ROUND_HALF_UP_PKR',
  ROUND_HALF_EVEN: 'ROUND_HALF_EVEN',
  TRUNCATE: 'TRUNCATE'
};

const TAX_POSTING_STATUS = {
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  POSTED: 'POSTED',
  REVERSED: 'REVERSED',
  PARTIALLY_REVERSED: 'PARTIALLY_REVERSED'
};

const TAX_REGISTER_ENTRY_TYPE = {
  INVOICE_TAX: 'INVOICE_TAX',
  TAX_REVERSAL: 'TAX_REVERSAL',
  /**
   * @deprecated Remittance is settlement of liability, not a tax event.
   * Do not create new REMITTANCE register rows — update status/refs on tax event rows
   * and keep remittance detail on TaxDeposit + GL voucher.
   */
  REMITTANCE: 'REMITTANCE',
  ADJUSTMENT: 'ADJUSTMENT',
  WRITEOFF_TAX: 'WRITEOFF_TAX'
};

const TAX_REGISTER_STATUS = {
  OPEN: 'OPEN',
  INCLUDED_IN_DEPOSIT: 'INCLUDED_IN_DEPOSIT',
  REMITTED: 'REMITTED',
  ADJUSTED: 'ADJUSTED',
  REVERSED: 'REVERSED',
  /** @deprecated legacy — treat as REMITTED in UI/APIs */
  PARTIALLY_CLEARED: 'PARTIALLY_CLEARED',
  /** @deprecated legacy synonym of REMITTED */
  CLEARED: 'CLEARED',
  VOID: 'VOID'
};

const TAX_DEPOSIT_STATUS = {
  DRAFT: 'DRAFT',
  /** Posted to GL — remittance is complete (no separate Close step). */
  SUBMITTED: 'SUBMITTED',
  /** @deprecated optional archival alias of SUBMITTED — UI treats as Submitted */
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
  /** Reversed after submit — register entries reopened; reversing GL posted */
  REVERSED: 'REVERSED'
};

/** Normalize legacy register statuses for display / filters. */
const normalizeRegisterStatus = (status) => {
  if (status === TAX_REGISTER_STATUS.CLEARED || status === TAX_REGISTER_STATUS.PARTIALLY_CLEARED) {
    return TAX_REGISTER_STATUS.REMITTED;
  }
  return status;
};

/** Statuses that mean "still open for remittance selection". */
const OPEN_FOR_DEPOSIT_STATUSES = [TAX_REGISTER_STATUS.OPEN];

/** Statuses counted as outstanding liability. */
const OUTSTANDING_REGISTER_STATUSES = [
  TAX_REGISTER_STATUS.OPEN,
  TAX_REGISTER_STATUS.PARTIALLY_CLEARED
];

const TAX_REGISTER_DIRECTION = {
  PAYABLE: 'PAYABLE',
  RECEIVABLE: 'RECEIVABLE'
};

const TAX_ENGINE_VERSION = '1.0';
const TAX_POSTING_VERSION = '1.0';

/** Well-known liability account for Pakistan Advance Tax. */
const TAX_ACCOUNT_CODES = {
  ADVANCE_TAX_PAYABLE: '2140'
};

const listTaxTypeCodes = () => Object.keys(TAX_TYPE_CODES);

const getTaxTypeMeta = (code) => TAX_TYPE_CODES[code] || null;

const isKnownTaxTypeCode = (code) => Boolean(TAX_TYPE_CODES[code]);

module.exports = {
  TAX_CATEGORY,
  TAX_TYPE_CODES,
  CALCULATION_BASE,
  CALCULATION_METHOD,
  TAX_APPLIES_TO,
  TAX_POSTING_BEHAVIOR,
  PHARMACY_TAX_STATUS,
  MISSING_TAX_STATUS_BEHAVIOUR,
  TAX_YEAR_MODE,
  TAX_ROUNDING_STRATEGY,
  TAX_POSTING_STATUS,
  TAX_REGISTER_ENTRY_TYPE,
  TAX_REGISTER_STATUS,
  TAX_DEPOSIT_STATUS,
  TAX_REGISTER_DIRECTION,
  TAX_ENGINE_VERSION,
  TAX_POSTING_VERSION,
  TAX_ACCOUNT_CODES,
  normalizeRegisterStatus,
  OPEN_FOR_DEPOSIT_STATUSES,
  OUTSTANDING_REGISTER_STATUSES,
  listTaxTypeCodes,
  getTaxTypeMeta,
  isKnownTaxTypeCode
};
