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

const salaryStructureSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    basicSalary: { type: Number, required: true, min: 0 },
    /** Paid only for PRESENT / half for HALF_DAY; see payroll + attendance */
    dailyAllowance: { type: Number, default: 0, min: 0 },
    allowances: { type: [allowanceDeductionItemSchema], default: [] },
    deductions: { type: [allowanceDeductionItemSchema], default: [] },
    commission: { type: commissionSchema, default: () => ({ type: 'percentage', value: 0 }) },
    effectiveFrom: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
    /** Reserved for future: attendance rules, leave policies */
    extensions: { type: mongoose.Schema.Types.Mixed }
  },
  { timestamps: true }
);

salaryStructureSchema.index({ companyId: 1, employeeId: 1, isActive: 1 });
salaryStructureSchema.index({ companyId: 1, employeeId: 1, effectiveFrom: -1 });

salaryStructureSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('SalaryStructure', salaryStructureSchema);
