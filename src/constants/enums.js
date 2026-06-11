const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  MEDICAL_REP: 'MEDICAL_REP'
};

/** Tenant model: company users vs platform (multi-company) users. */
const USER_TYPES = {
  COMPANY: 'COMPANY',
  PLATFORM: 'PLATFORM'
};

const ORDER_STATUS = {
  PENDING: 'PENDING',
  PARTIALLY_DELIVERED: 'PARTIALLY_DELIVERED',
  DELIVERED: 'DELIVERED',
  PARTIALLY_RETURNED: 'PARTIALLY_RETURNED',
  RETURNED: 'RETURNED',
  CANCELLED: 'CANCELLED'
};

const LEDGER_TYPE = {
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT'
};

const LEDGER_ENTITY_TYPE = {
  PHARMACY: 'PHARMACY',
  /** Net clearing: positive balance (DR-CR) = distributor owes company; negative = company owes distributor. entityId = distributorId */
  DISTRIBUTOR_CLEARING: 'DISTRIBUTOR_CLEARING'
};

const COLLECTOR_TYPE = {
  COMPANY: 'COMPANY',
  DISTRIBUTOR: 'DISTRIBUTOR'
};

const SETTLEMENT_DIRECTION = {
  DISTRIBUTOR_TO_COMPANY: 'DISTRIBUTOR_TO_COMPANY',
  COMPANY_TO_DISTRIBUTOR: 'COMPANY_TO_DISTRIBUTOR'
};

const LEDGER_REFERENCE_TYPE = {
  ORDER: 'ORDER',
  PAYMENT: 'PAYMENT',
  RETURN: 'RETURN',
  DELIVERY: 'DELIVERY',
  COLLECTION: 'COLLECTION',
  SETTLEMENT: 'SETTLEMENT',
  RETURN_CLEARING_ADJ: 'RETURN_CLEARING_ADJ',
  OPENING_BALANCE: 'OPENING_BALANCE'
};

/** meta.portion on COLLECTION lines in DISTRIBUTOR_CLEARING */
const LEDGER_COLLECTION_PORTION = {
  /** Distributor collected cash: company’s share to remit to company */
  REMITTANCE_DUE_TO_COMPANY: 'REMITTANCE_DUE_TO_COMPANY',
  /** Distributor collected cash: distributor’s commission on TP (portion of this collection) */
  DISTRIBUTOR_COMMISSION_ON_COLLECTION: 'DISTRIBUTOR_COMMISSION_ON_COLLECTION',
  /** Company collected cash: commission owed by company to distributor on this slice */
  COMMISSION_PAYABLE_TO_DISTRIBUTOR: 'COMMISSION_PAYABLE_TO_DISTRIBUTOR'
};

const TRANSACTION_TYPE = {
  SALE: 'SALE',
  RETURN: 'RETURN',
  EXPENSE: 'EXPENSE'
};

const PAYMENT_METHOD = {
  CASH: 'CASH',
  CHEQUE: 'CHEQUE',
  BANK_TRANSFER: 'BANK_TRANSFER',
  UPI: 'UPI'
};

const EXPENSE_CATEGORY = {
  DOCTOR_INVESTMENT: 'DOCTOR_INVESTMENT',
  SALARY: 'SALARY',
  RENT: 'RENT',
  LOGISTICS: 'LOGISTICS',
  OFFICE: 'OFFICE',
  OTHER: 'OTHER'
};

/** Field expense approval workflow — default APPROVED preserves legacy auto-post behaviour. */
const EXPENSE_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED'
};

const NOTIFICATION_KIND = {
  GENERAL: 'GENERAL',
  ANNOUNCEMENT: 'ANNOUNCEMENT',
  EXPENSE: 'EXPENSE',
  PLAN: 'PLAN',
  ATTENDANCE: 'ATTENDANCE'
};

const PAYROLL_STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID'
};

const ATTENDANCE_STATUS = {
  PRESENT: 'PRESENT',
  ABSENT: 'ABSENT',
  HALF_DAY: 'HALF_DAY',
  LEAVE: 'LEAVE'
};

const ATTENDANCE_MARKED_BY = {
  SELF: 'SELF',
  ADMIN: 'ADMIN'
};

/** How check-in was recorded (governance / audit). Legacy rows may omit. */
const ATTENDANCE_CHECKIN_SOURCE = {
  USER: 'USER',
  ADMIN: 'ADMIN'
};

/** How check-out was recorded. UNKNOWN_LEGACY for rows before governance fields existed. */
const ATTENDANCE_CHECKOUT_SOURCE = {
  USER: 'USER',
  SYSTEM_AUTO: 'SYSTEM_AUTO',
  ADMIN: 'ADMIN',
  UNKNOWN_LEGACY: 'UNKNOWN_LEGACY'
};

/** Attendance regularization / approval request categories. */
const ATTENDANCE_REQUEST_TYPE = {
  LATE_ARRIVAL: 'LATE_ARRIVAL',
  MISSED_CHECKOUT: 'MISSED_CHECKOUT',
  TIME_CORRECTION: 'TIME_CORRECTION',
  MANUAL_EXCEPTION: 'MANUAL_EXCEPTION'
};

const ATTENDANCE_REQUEST_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  ESCALATED: 'ESCALATED'
};

/**
 * Late self check-in when strict blocking is on: time is recorded but manager must approve
 * before check-out / payroll “present” counts (see Attendance.lateCheckInApprovalStatus).
 */
const LATE_CHECKIN_APPROVAL_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED'
};

const WEEKLY_PLAN_STATUS = {
  DRAFT: 'DRAFT',
  /**
   * Manager approval workflow (Phase 2B). Only used when Company.weeklyPlanApprovalRequired = true.
   * Rep submits → manager approves (→ ACTIVE) or rejects (→ DRAFT with rejectedReason set).
   */
  SUBMITTED: 'SUBMITTED',
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  /** @deprecated legacy workflow — retained for existing rows */
  REVIEWED: 'REVIEWED'
};

const PLAN_ITEM_TYPE = {
  DOCTOR_VISIT: 'DOCTOR_VISIT',
  OTHER_TASK: 'OTHER_TASK'
};

const PLAN_ITEM_STATUS = {
  PENDING: 'PENDING',
  VISITED: 'VISITED',
  MISSED: 'MISSED'
};

/** Derived per calendar day for a rep (plan execution UI). */
const DAY_EXECUTION_STATE = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED'
};

/** Why a visit was logged off-plan (audit / deviation analytics). */
const UNPLANNED_VISIT_REASON = {
  EMERGENCY: 'EMERGENCY',
  AVAILABLE_UNEXPECTEDLY: 'AVAILABLE_UNEXPECTEDLY',
  OTHER: 'OTHER'
};

/** Progressive doctor coordinate lifecycle for visit geo-fencing. */
const DOCTOR_LOCATION_STATUS = {
  UNVERIFIED: 'UNVERIFIED',
  SUGGESTED: 'SUGGESTED',
  VERIFIED: 'VERIFIED'
};

const DOCTOR_LOCATION_SUGGESTION_SOURCE = {
  VISIT_COMPLETION: 'VISIT_COMPLETION',
  MANUAL_PIN: 'MANUAL_PIN'
};

const DOCTOR_LOCATION_SUGGESTION_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED'
};

/** Company visit geo-fence enforcement mode (only applies when geoFencingEnabled). */
const GEO_FENCE_MODE = {
  OFF: 'OFF',
  SOFT: 'SOFT',
  STRICT: 'STRICT'
};

/** Stored on VisitLog after visit completion geo evaluation. */
const GEO_FENCE_RESULT = {
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  INSIDE_RADIUS: 'INSIDE_RADIUS',
  OUTSIDE_RADIUS: 'OUTSIDE_RADIUS'
};

/** MRep 3-level org territory tree (single collection, self-referencing). */
const TERRITORY_KIND = {
  ZONE: 'ZONE',
  AREA: 'AREA',
  BRICK: 'BRICK'
};

/** Allowed parent kind for each TERRITORY_KIND (BRICK→AREA, AREA→ZONE, ZONE→null). */
const TERRITORY_PARENT_KIND = {
  ZONE: null,
  AREA: TERRITORY_KIND.ZONE,
  BRICK: TERRITORY_KIND.AREA
};

/** Doctor investment / commitment tracking (TP-based achieved sales) */
const DOCTOR_ACTIVITY_STATUS = {
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
};

/** Procurement PO lifecycle — no stock / no supplier liability until GRN (Phase 2+). */
const PURCHASE_ORDER_STATUS = {
  DRAFT: 'DRAFT',
  APPROVED: 'APPROVED',
  PARTIALLY_RECEIVED: 'PARTIALLY_RECEIVED',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED'
};

/** GRN posting state; inventory + supplier PURCHASE ledger only after POSTED (Phase 2+). */
const GOODS_RECEIPT_NOTE_STATUS = {
  DRAFT: 'DRAFT',
  POSTED: 'POSTED',
  CANCELLED: 'CANCELLED',
  /** Full document reversal (admin); original GRN rows unchanged. */
  REVERSED: 'REVERSED'
};

const SUPPLIER_INVOICE_STATUS = {
  DRAFT: 'DRAFT',
  POSTED: 'POSTED'
};

/**
 * Supplier (factory) liability ledger — not PnL.
 * PURCHASE increases payable; PAYMENT reduces it; ADJUSTMENT handles invoice↔GRN mismatch (Phase 3+).
 */
const SUPPLIER_LEDGER_TYPE = {
  PURCHASE: 'PURCHASE',
  PAYMENT: 'PAYMENT',
  ADJUSTMENT: 'ADJUSTMENT',
  /** Posted purchase return — reduces supplier payable (same running-balance effect as PAYMENT). */
  PURCHASE_RETURN: 'PURCHASE_RETURN'
};

/** When type === ADJUSTMENT: whether payable goes up (like purchase) or down (like payment). */
const SUPPLIER_LEDGER_ADJUSTMENT_EFFECT = {
  INCREASE_PAYABLE: 'INCREASE_PAYABLE',
  DECREASE_PAYABLE: 'DECREASE_PAYABLE'
};

const SUPPLIER_LEDGER_REFERENCE_TYPE = {
  STOCK_TRANSFER: 'STOCK_TRANSFER',
  MANUAL: 'MANUAL',
  /** Procurement: liability from posted GRN — referenceId = GoodsReceiptNote */
  GOODS_RECEIPT_NOTE: 'GOODS_RECEIPT_NOTE',
  /** Optional link to supplier invoice document */
  SUPPLIER_INVOICE: 'SUPPLIER_INVOICE',
  /** Invoice vs GRN / other procurement adjustments */
  PROCUREMENT_ADJUSTMENT: 'PROCUREMENT_ADJUSTMENT',
  /** Idempotent link to posted PurchaseReturn document */
  PURCHASE_RETURN: 'PURCHASE_RETURN',
  /** Full posted GRN reversal — liability offset row (ADJUSTMENT DECREASE) */
  GOODS_RECEIPT_NOTE_REVERSAL: 'GOODS_RECEIPT_NOTE_REVERSAL'
};

/** Purchase return document lifecycle */
const PURCHASE_RETURN_STATUS = {
  DRAFT: 'DRAFT',
  POSTED: 'POSTED'
};

/** Recorded on SupplierLedger rows where type === PAYMENT (audit / voucher) */
const SUPPLIER_PAYMENT_METHOD = {
  CASH: 'CASH',
  BANK: 'BANK',
  CHEQUE: 'CHEQUE',
  OTHER: 'OTHER'
};

const SUPPLIER_PAYMENT_VERIFICATION = {
  VERIFIED: 'VERIFIED',
  UNVERIFIED: 'UNVERIFIED'
};

/** Chart of Accounts — top-level classification (Orbit-like). */
const ACCOUNT_GROUP_TYPE = {
  ASSET: 'ASSET',
  LIABILITY: 'LIABILITY',
  EQUITY: 'EQUITY',
  INCOME: 'INCOME',
  EXPENSE: 'EXPENSE'
};

/** Normal balance side for an account group (debit-normal vs credit-normal). */
const ACCOUNT_NORMAL_BALANCE = {
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT'
};

const VOUCHER_TYPE = {
  JV: 'JV',
  PV: 'PV',
  RV: 'RV',
  CV: 'CV',
  SV: 'SV',
  PURV: 'PURV',
  AUTO: 'AUTO'
};

const VOUCHER_STATUS = {
  DRAFT: 'DRAFT',
  POSTED: 'POSTED',
  REVERSED: 'REVERSED'
};

const SUB_LEDGER_SOURCE = {
  LEDGER: 'LEDGER',
  SUPPLIER_LEDGER: 'SUPPLIER_LEDGER'
};

const GL_SOURCE_MODULE = {
  MANUAL: 'MANUAL',
  ORDER: 'ORDER',
  COLLECTION: 'COLLECTION',
  SETTLEMENT: 'SETTLEMENT',
  EXPENSE: 'EXPENSE',
  SUPPLIER: 'SUPPLIER',
  PROCUREMENT: 'PROCUREMENT',
  OPENING: 'OPENING',
  FUND_TRANSFER: 'FUND_TRANSFER'
};

/** Liquid accounts used for real cash/bank movements. */
const MONEY_ACCOUNT_NATURE = {
  CASH: 'CASH',
  BANK: 'BANK'
};

module.exports = {
  ROLES,
  USER_TYPES,
  ORDER_STATUS,
  LEDGER_TYPE,
  LEDGER_ENTITY_TYPE,
  COLLECTOR_TYPE,
  SETTLEMENT_DIRECTION,
  LEDGER_REFERENCE_TYPE,
  LEDGER_COLLECTION_PORTION,
  TRANSACTION_TYPE,
  PAYMENT_METHOD,
  EXPENSE_CATEGORY,
  EXPENSE_STATUS,
  NOTIFICATION_KIND,
  PAYROLL_STATUS,
  ATTENDANCE_STATUS,
  ATTENDANCE_MARKED_BY,
  ATTENDANCE_CHECKIN_SOURCE,
  ATTENDANCE_CHECKOUT_SOURCE,
  ATTENDANCE_REQUEST_TYPE,
  ATTENDANCE_REQUEST_STATUS,
  LATE_CHECKIN_APPROVAL_STATUS,
  WEEKLY_PLAN_STATUS,
  PLAN_ITEM_TYPE,
  PLAN_ITEM_STATUS,
  DAY_EXECUTION_STATE,
  UNPLANNED_VISIT_REASON,
  DOCTOR_LOCATION_STATUS,
  DOCTOR_LOCATION_SUGGESTION_SOURCE,
  DOCTOR_LOCATION_SUGGESTION_STATUS,
  GEO_FENCE_MODE,
  GEO_FENCE_RESULT,
  TERRITORY_KIND,
  TERRITORY_PARENT_KIND,
  DOCTOR_ACTIVITY_STATUS,
  PURCHASE_ORDER_STATUS,
  GOODS_RECEIPT_NOTE_STATUS,
  SUPPLIER_INVOICE_STATUS,
  SUPPLIER_LEDGER_TYPE,
  SUPPLIER_LEDGER_ADJUSTMENT_EFFECT,
  SUPPLIER_LEDGER_REFERENCE_TYPE,
  SUPPLIER_PAYMENT_METHOD,
  SUPPLIER_PAYMENT_VERIFICATION,
  PURCHASE_RETURN_STATUS,
  ACCOUNT_GROUP_TYPE,
  ACCOUNT_NORMAL_BALANCE,
  VOUCHER_TYPE,
  VOUCHER_STATUS,
  SUB_LEDGER_SOURCE,
  GL_SOURCE_MODULE,
  MONEY_ACCOUNT_NATURE
};
