const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const productKitSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    code: { type: String, trim: true, maxlength: 64, default: null },
    description: { type: String, trim: true, maxlength: 2000 },
    productIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
      validate: {
        validator(v) {
          return Array.isArray(v) && v.length >= 2;
        },
        message: 'A kit must contain at least 2 products'
      }
    },
    heroAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'MediaAsset', default: null },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 }
  },
  { timestamps: true }
);

productKitSchema.index({ companyId: 1, isActive: 1, sortOrder: 1 });
productKitSchema.index(
  { companyId: 1, code: 1 },
  {
    unique: true,
    partialFilterExpression: { code: { $type: 'string' }, isDeleted: { $ne: true } }
  }
);

productKitSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('ProductKit', productKitSchema);
