const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const productSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true },
    composition: { type: String, trim: true },
    mrp: { type: Number, required: true },
    tp: { type: Number, required: true },
    tpPercent: { type: Number },
    casting: { type: Number, required: true },
    castingPercent: { type: Number },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

productSchema.index({ companyId: 1, name: 1 });
productSchema.index({ companyId: 1, isActive: 1 });

productSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Product', productSchema);
