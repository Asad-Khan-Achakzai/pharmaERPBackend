const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const fiscalPeriodSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    isClosed: { type: Boolean, default: false },
    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

fiscalPeriodSchema.index({ companyId: 1, startDate: -1 });
fiscalPeriodSchema.index({ companyId: 1, isClosed: 1 });

fiscalPeriodSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('FiscalPeriod', fiscalPeriodSchema);
