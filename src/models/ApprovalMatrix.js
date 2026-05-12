const mongoose = require('mongoose');
const { ATTENDANCE_REQUEST_TYPE } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

/**
 * Configurable routing steps (non-hardcoded). Resolver types interpreted by attendanceWorkflow.service.
 * requestCategory ALL matches any type when no specific matrix exists.
 */
const approvalMatrixSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true },
    requestCategory: {
      type: String,
      enum: ['ALL', ...Object.values(ATTENDANCE_REQUEST_TYPE)],
      default: 'ALL'
    },
    /**
     * Ordered steps: { order, resolverType, depth?, requiredPermission? }
     * resolverType: DIRECT_MANAGER | MANAGER_AT_DEPTH | ADMIN_QUEUE
     */
    steps: { type: [mongoose.Schema.Types.Mixed], default: () => [] },
    isActive: { type: Boolean, default: true },
    effectiveFrom: { type: Date, default: () => new Date(0) },
    effectiveTo: { type: Date, default: null }
  },
  { timestamps: true }
);

approvalMatrixSchema.index({ companyId: 1, requestCategory: 1, isActive: 1 });
approvalMatrixSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('ApprovalMatrix', approvalMatrixSchema);
