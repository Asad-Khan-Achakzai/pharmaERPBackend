const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

/**
 * Company-global product master (one sellable SKU per document).
 * Catalog enrichment is additive — order/inventory/visit FKs stay on `_id`.
 */
const productSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true },
    /** Unique product code per company (backfilled for legacy rows). */
    sku: { type: String, trim: true, maxlength: 64, default: null },
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', default: null },
    /** Legacy composition text; prefer genericName for catalog. */
    composition: { type: String, trim: true },
    genericName: { type: String, trim: true, maxlength: 300 },
    strength: { type: String, trim: true, maxlength: 120 },
    dosageForm: { type: String, trim: true, maxlength: 120 },
    packSize: { type: String, trim: true, maxlength: 120 },
    manufacturer: { type: String, trim: true, maxlength: 200 },
    taxonomyNodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductTaxonomyNode',
      default: null
    },
    /** Denormalized labels for offline/list display: [Therapy, Area, Class]. */
    taxonomyPathLabels: { type: [String], default: undefined },
    description: { type: String, trim: true, maxlength: 5000 },
    indications: { type: String, trim: true, maxlength: 5000 },
    contraindications: { type: String, trim: true, maxlength: 5000 },
    dosageInstructions: { type: String, trim: true, maxlength: 5000 },
    sideEffects: { type: String, trim: true, maxlength: 5000 },
    storageInstructions: { type: String, trim: true, maxlength: 2000 },
    mrp: { type: Number, required: true },
    tp: { type: Number, required: true },
    tpPercent: { type: Number },
    casting: { type: Number, required: true },
    castingPercent: { type: Number },
    distributorPrice: { type: Number, min: 0, default: null },
    sortOrder: { type: Number, default: 0 },
    /** Monotonic version for mobile delta sync (bumped on catalog-relevant changes). */
    catalogVersion: { type: Number, default: 1, index: true },
    isSampleEligible: { type: Boolean, default: false },
    sampleUnitLabel: { type: String, trim: true, maxlength: 64, default: null },
    defaultPresentationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductPresentation',
      default: null
    },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

productSchema.index({ companyId: 1, name: 1 });
productSchema.index({ companyId: 1, isActive: 1 });
productSchema.index({ companyId: 1, isActive: 1, catalogVersion: 1 });
productSchema.index({ companyId: 1, taxonomyNodeId: 1 });
productSchema.index({ companyId: 1, brandId: 1 });
productSchema.index(
  { companyId: 1, sku: 1 },
  {
    unique: true,
    partialFilterExpression: { sku: { $type: 'string' }, isDeleted: { $ne: true } }
  }
);
/** Text index for catalog discovery (Atlas Search can replace later). */
productSchema.index({
  name: 'text',
  genericName: 'text',
  sku: 'text',
  composition: 'text',
  manufacturer: 'text',
  indications: 'text'
});

productSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Product', productSchema);
