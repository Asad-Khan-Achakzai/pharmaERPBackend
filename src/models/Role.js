const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const roleSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true, default: null },
    permissions: [{ type: String }],
    isSystem: { type: Boolean, default: false, index: true }
  },
  { timestamps: true }
);

roleSchema.index({ companyId: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });

roleSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Role', roleSchema);
