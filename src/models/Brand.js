const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const brandSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    code: { type: String, trim: true, maxlength: 64, default: null },
    description: { type: String, trim: true, maxlength: 2000 },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

brandSchema.index({ companyId: 1, name: 1 });
brandSchema.index({ companyId: 1, isActive: 1 });
brandSchema.index(
  { companyId: 1, code: 1 },
  {
    unique: true,
    partialFilterExpression: { code: { $type: 'string' }, isDeleted: { $ne: true } }
  }
);

brandSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Brand', brandSchema);
