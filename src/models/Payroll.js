const mongoose = require('mongoose');
const { PAYROLL_STATUS } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const lineItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    amount: { type: Number, required: true }
  },
  { _id: false }
);

const commissionSnapshotSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['percentage'], default: 'percentage' },
    value: { type: Number, default: 0 },
    salesTotal: { type: Number, default: 0 },
    amount: { type: Number, default: 0 }
  },
  { _id: false }
);

const productIncentiveSlabSnapshotSchema = new mongoose.Schema(
  {
    fromPacks: { type: Number },
    toPacks: { type: Number, default: null },
    ratePerPack: { type: Number }
  },
  { _id: false }
);

const productIncentiveLineSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    productName: { type: String },
    deliveredQty: { type: Number, default: 0 },
    includeBonusQty: { type: Boolean, default: true },
    matchedSlab: { type: productIncentiveSlabSnapshotSchema },
    amount: { type: Number, default: 0 },
    calculationType: { type: String, enum: ['pack_slab'], default: 'pack_slab' }
  },
  { _id: false }
);

const productIncentiveRuleSnapshotSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['pack_slab'], default: 'pack_slab' },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    includeBonusQty: { type: Boolean, default: true },
    slabs: { type: [productIncentiveSlabSnapshotSchema], default: [] }
  },
  { _id: false }
);

const payrollSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    month: { type: String, required: true },
    /** Inclusive payroll period (v1: calendar month boundaries from month + company TZ) */
    periodFrom: { type: Date },
    periodTo: { type: Date },
    /** Basic salary (same meaning as legacy baseSalary; kept for clarity in snapshots) */
    baseSalary: { type: Number, required: true },
    /** Legacy: lump bonus; kept for backward compatibility */
    bonus: { type: Number, default: 0 },
    /** Legacy: single deduction total when calculationMode is manual */
    deductions: { type: Number, default: 0 },
    netSalary: { type: Number, required: true },
    paidOn: { type: Date },
    status: { type: String, enum: Object.values(PAYROLL_STATUS), default: PAYROLL_STATUS.PENDING },

    calculationMode: {
      type: String,
      enum: ['manual', 'structure'],
      default: 'manual'
    },
    /** Reference to structure version used when snapshot was built (optional) */
    salaryStructureId: { type: mongoose.Schema.Types.ObjectId, ref: 'SalaryStructure' },
    salaryStructureNameSnapshot: { type: String },
    grossSalary: { type: Number },
    allowanceLines: { type: [lineItemSchema], default: [] },
    deductionLines: { type: [lineItemSchema], default: [] },
    commission: { type: commissionSnapshotSchema },
    productIncentiveTotal: { type: Number, default: 0 },
    productIncentiveLines: { type: [productIncentiveLineSchema], default: [] },
    productIncentiveRulesSnapshot: { type: [productIncentiveRuleSnapshotSchema], default: [] },
    /** Rate from salary structure at run time */
    dailyAllowance: { type: Number, default: 0 },
    presentDays: { type: Number, default: 0 },
    absentDays: { type: Number, default: 0 },
    halfDays: { type: Number, default: 0 },
    leaveDays: { type: Number, default: 0 },
    totalDaysInMonth: { type: Number, default: 0 },
    dailyAllowanceTotal: { type: Number, default: 0 },
    attendanceDeduction: { type: Number, default: 0 },
    payrollExtensions: { type: mongoose.Schema.Types.Mixed }
  },
  { timestamps: true }
);

payrollSchema.index({ companyId: 1, status: 1, paidOn: -1 });

payrollSchema.plugin(softDeletePlugin);

/** Only enforce uniqueness for active rows (isDeleted === false). Soft-deleted docs are omitted from the index.
 *  Atlas rejects $ne / $exists:false in partial filters (they use $not). Legacy rows must set isDeleted explicitly — see fixPayrollPartialUniqueIndex.js */
payrollSchema.index(
  { companyId: 1, employeeId: 1, month: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

module.exports = mongoose.model('Payroll', payrollSchema);
