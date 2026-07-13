const mongoose = require('mongoose');
const { PRODUCT_TAXONOMY_KIND } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

/**
 * Hierarchical product taxonomy (Therapy → Area → Class), Territory-style.
 * Products reference any node via taxonomyNodeId; subtree queries use materializedPath.
 */
const productTaxonomyNodeSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    code: { type: String, trim: true, maxlength: 64, default: null },
    kind: {
      type: String,
      enum: Object.values(PRODUCT_TAXONOMY_KIND),
      required: true
    },
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductTaxonomyNode',
      default: null,
      index: true
    },
    materializedPath: { type: String, default: '/', index: true },
    depth: { type: Number, default: 0 },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

productTaxonomyNodeSchema.index({ companyId: 1, kind: 1, isActive: 1 });
productTaxonomyNodeSchema.index({ companyId: 1, parentId: 1, isActive: 1 });
productTaxonomyNodeSchema.index({ companyId: 1, materializedPath: 1 });
productTaxonomyNodeSchema.index(
  { companyId: 1, kind: 1, code: 1 },
  {
    unique: true,
    partialFilterExpression: { code: { $type: 'string' }, isDeleted: { $ne: true } }
  }
);

productTaxonomyNodeSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('ProductTaxonomyNode', productTaxonomyNodeSchema);
