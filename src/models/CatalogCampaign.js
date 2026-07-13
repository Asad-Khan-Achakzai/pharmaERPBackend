const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const CAMPAIGN_TYPES = ['FEATURED', 'NEW_LAUNCH', 'SEASONAL', 'COLLECTION', 'CUSTOM'];

const catalogCampaignSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    code: { type: String, trim: true, maxlength: 64, default: null },
    type: { type: String, enum: CAMPAIGN_TYPES, required: true, default: 'FEATURED' },
    description: { type: String, trim: true, maxlength: 2000 },
    bannerAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'MediaAsset', default: null },
    productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 }
  },
  { timestamps: true }
);

catalogCampaignSchema.index({ companyId: 1, isActive: 1, sortOrder: 1 });
catalogCampaignSchema.index({ companyId: 1, startAt: 1, endAt: 1 });

catalogCampaignSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('CatalogCampaign', catalogCampaignSchema);
module.exports.CAMPAIGN_TYPES = CAMPAIGN_TYPES;
