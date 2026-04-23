const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const medRepTargetSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    medicalRepId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    month: { type: String, required: true },
    salesTarget: { type: Number, required: true },
    packsTarget: { type: Number, required: true },
    achievedSales: { type: Number, default: 0 },
    achievedPacks: { type: Number, default: 0 }
  },
  { timestamps: true }
);

medRepTargetSchema.index({ companyId: 1, medicalRepId: 1, month: 1 }, { unique: true });

medRepTargetSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('MedRepTarget', medRepTargetSchema);
