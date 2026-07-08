const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

/**
 * In-progress visit session (started but not yet completed).
 * Synced across web and mobile; cleared when the visit is marked complete.
 */
const activeVisitSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clientUuid: { type: String, required: true, trim: true, maxlength: 64 },
    planItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlanItem', default: null },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    startedAt: { type: Date, required: true },
    visitStarted: { type: Boolean, default: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

activeVisitSchema.index({ companyId: 1, employeeId: 1, clientUuid: 1 }, { unique: true });
activeVisitSchema.index(
  { companyId: 1, employeeId: 1, planItemId: 1 },
  { unique: true, sparse: true, partialFilterExpression: { planItemId: { $type: 'objectId' }, isDeleted: { $ne: true } } }
);
activeVisitSchema.index({ companyId: 1, employeeId: 1, updatedAt: -1 });

activeVisitSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('ActiveVisit', activeVisitSchema);
