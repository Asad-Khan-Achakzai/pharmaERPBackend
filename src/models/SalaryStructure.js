const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const allowanceDeductionItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['fixed', 'percentage'], required: true },
    value: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const commissionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['percentage'], default: 'percentage' },
    value: { type: Number, default: 0, min: 0, max: 100 }
  },
  { _id: false }
);

const productPackSlabSchema = new mongoose.Schema(
  {
    fromPacks: { type: Number, required: true, min: 1 },
    toPacks: { type: Number, min: 1, default: null },
    ratePerPack: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const productPackIncentiveSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['pack_slab'], default: 'pack_slab' },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    includeBonusQty: { type: Boolean, default: true },
    slabs: { type: [productPackSlabSchema], default: [] }
  },
  { _id: false }
);

const salaryStructureSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    /** Reusable template name (required for isTemplate documents). */
    name: { type: String, trim: true },
    description: { type: String, trim: true, default: '' },
    code: { type: String, trim: true, default: '' },
    /** true = reusable template; false = legacy per-employee row kept for payroll audit. */
    isTemplate: { type: Boolean, default: true },
    /** Legacy only — pre-migration employee-bound structures. */
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    basicSalary: { type: Number, required: true, min: 0 },
    dailyAllowance: { type: Number, default: 0, min: 0 },
    allowances: { type: [allowanceDeductionItemSchema], default: [] },
    deductions: { type: [allowanceDeductionItemSchema], default: [] },
    commission: { type: commissionSchema, default: () => ({ type: 'percentage', value: 0 }) },
    productPackIncentives: { type: [productPackIncentiveSchema], default: [] },
    /** Legacy per-employee version effective date; unused on templates. */
    effectiveFrom: { type: Date },
    /** Template enabled flag (archived templates = false). Legacy rows use isActive for version chain. */
    isActive: { type: Boolean, default: true },
    extensions: { type: mongoose.Schema.Types.Mixed }
  },
  { timestamps: true }
);

salaryStructureSchema.index(
  { companyId: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false, isTemplate: true, name: { $type: 'string' } }
  }
);
salaryStructureSchema.index({ companyId: 1, isTemplate: 1, isActive: 1 });
salaryStructureSchema.index({ companyId: 1, employeeId: 1, isActive: 1 });
salaryStructureSchema.index({ companyId: 1, employeeId: 1, effectiveFrom: -1 });

salaryStructureSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('SalaryStructure', salaryStructureSchema);
