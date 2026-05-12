const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

/** Binds an AttendancePolicy to an employee (or company-wide when employeeId is null). */
const policyAssignmentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    policyId: { type: mongoose.Schema.Types.ObjectId, ref: 'AttendancePolicy', required: true },
    /** null = company default assignment overlay (optional; prefer named default policy). */
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    effectiveFrom: { type: Date, default: () => new Date(0) },
    effectiveTo: { type: Date, default: null }
  },
  { timestamps: true }
);

policyAssignmentSchema.index({ companyId: 1, employeeId: 1 });
policyAssignmentSchema.index({ companyId: 1, effectiveFrom: 1, effectiveTo: 1 });
policyAssignmentSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('PolicyAssignment', policyAssignmentSchema);
