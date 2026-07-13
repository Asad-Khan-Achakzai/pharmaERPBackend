const mongoose = require('mongoose');

const ENGAGEMENT_EVENT_TYPES = [
  'CATALOG_VIEW',
  'PRODUCT_VIEW',
  'SEARCH',
  'SEARCH_CLICK',
  'FAVORITE_ADD',
  'FAVORITE_REMOVE',
  'COMPARE_OPEN',
  'MEDIA_OPEN',
  'MEDIA_DOWNLOAD',
  'PRESENTATION_START',
  'SLIDE_VIEW',
  'SLIDE_SKIP',
  'SLIDE_REVISIT',
  'SECTION_ENTER',
  'SECTION_EXIT',
  'COMPONENT_INTERACT',
  'PRESENTATION_COMPLETE',
  'PRESENTATION_ABORT',
  'CAMPAIGN_SECTION_VIEW',
  'CAMPAIGN_PRODUCT_CLICK',
  'KIT_VIEW',
  'KIT_PRESENT_START',
  'PRESENTED_IN_VISIT'
];

/**
 * Append-only engagement stream for catalog analytics / AI readiness.
 * Deduped by (companyId, userId, clientEventId).
 */
const productEngagementEventSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    clientEventId: { type: String, required: true, trim: true, maxlength: 128 },
    eventType: { type: String, enum: ENGAGEMENT_EVENT_TYPES, required: true, index: true },
    occurredAt: { type: Date, required: true, index: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    presentationId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductPresentation', default: null },
    slideId: { type: mongoose.Schema.Types.ObjectId, default: null },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogCampaign', default: null },
    kitId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductKit', default: null },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },
    visitLogId: { type: mongoose.Schema.Types.ObjectId, ref: 'VisitLog', default: null },
    activeVisitId: { type: mongoose.Schema.Types.ObjectId, ref: 'ActiveVisit', default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

productEngagementEventSchema.index(
  { companyId: 1, userId: 1, clientEventId: 1 },
  { unique: true }
);
productEngagementEventSchema.index({ companyId: 1, productId: 1, eventType: 1, occurredAt: -1 });
productEngagementEventSchema.index({ companyId: 1, eventType: 1, occurredAt: -1 });

module.exports = mongoose.model('ProductEngagementEvent', productEngagementEventSchema);
module.exports.ENGAGEMENT_EVENT_TYPES = ENGAGEMENT_EVENT_TYPES;
