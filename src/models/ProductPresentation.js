const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const SLIDE_TYPES = [
  'IMAGE',
  'VIDEO',
  'PDF',
  'RICH_TEXT',
  'BENEFITS',
  'CLINICAL',
  'REMINDER',
  'SUMMARY',
  'HERO',
  'CTA',
  'PROBLEM',
  'MOA'
];

const SECTION_KEYS = [
  'PROBLEM',
  'DISEASE_OVERVIEW',
  'CURRENT_TREATMENT',
  'LIMITATIONS',
  'OUR_PRODUCT',
  'MOA',
  'CLINICAL_EVIDENCE',
  'KEY_BENEFITS',
  'PATIENT_OUTCOME',
  'SUMMARY',
  'CTA',
  'CUSTOM'
];

const PRESENTATION_STATUS = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

const COMPONENT_TYPES = [
  'HeroBanner',
  'ProductImage',
  'BenefitCard',
  'FeatureCard',
  'ClinicalStudyCard',
  'QuoteBlock',
  'StatisticCard',
  'CTABlock',
  'Badge',
  'RichText'
];

const componentInstanceSchema = new mongoose.Schema(
  {
    componentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    type: { type: String, enum: COMPONENT_TYPES, required: true },
    version: { type: Number, default: 1 },
    props: { type: mongoose.Schema.Types.Mixed, default: {} },
    style: { type: mongoose.Schema.Types.Mixed, default: null },
    analyticsId: { type: String, trim: true, maxlength: 64, default: null }
  },
  { _id: false }
);

const slideSchema = new mongoose.Schema(
  {
    slideId: { type: mongoose.Schema.Types.ObjectId, required: true },
    sortOrder: { type: Number, required: true, default: 0 },
    type: { type: String, enum: SLIDE_TYPES, required: true },
    sectionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    title: { type: String, trim: true, maxlength: 300 },
    body: { type: String, trim: true, maxlength: 10000 },
    /** Short scannable points for BENEFITS / SUMMARY / etc. */
    bullets: { type: [String], default: undefined },
    /** Big claim / statistic highlight */
    highlight: { type: String, trim: true, maxlength: 200, default: null },
    assetId: { type: mongoose.Schema.Types.ObjectId, ref: 'MediaAsset', default: null },
    backgroundAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'MediaAsset', default: null },
    iconKey: { type: String, trim: true, maxlength: 64, default: null },
    durationHintSec: { type: Number, min: 0, default: null },
    isOfflineEligible: { type: Boolean, default: true },
    /** Future-ready component tree; empty for legacy decks. */
    components: { type: [componentInstanceSchema], default: undefined }
  },
  { _id: false }
);

const sectionSchema = new mongoose.Schema(
  {
    sectionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    key: { type: String, enum: SECTION_KEYS, required: true },
    title: { type: String, trim: true, maxlength: 200 },
    sortOrder: { type: Number, default: 0 },
    isOptional: { type: Boolean, default: false },
    slideIds: [{ type: mongoose.Schema.Types.ObjectId }]
  },
  { _id: false }
);

const themeSchema = new mongoose.Schema(
  {
    primaryColor: { type: String, trim: true, maxlength: 32, default: '#0B6E4F' },
    secondaryColor: { type: String, trim: true, maxlength: 32, default: '#083D77' },
    surfaceStyle: {
      type: String,
      enum: ['dark', 'light', 'brandWash'],
      default: 'brandWash'
    },
    logoAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'MediaAsset', default: null },
    backgroundAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'MediaAsset', default: null },
    fontStyle: { type: String, enum: ['modern', 'classic'], default: 'modern' }
  },
  { _id: false }
);

const qualityCheckSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    severity: { type: String, enum: ['ERROR', 'WARN', 'INFO'], required: true },
    message: { type: String, required: true },
    slideId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sectionKey: { type: String, default: null }
  },
  { _id: false }
);

const productPresentationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    status: { type: String, enum: PRESENTATION_STATUS, default: 'DRAFT', index: true },
    version: { type: Number, default: 1 },
    isDefault: { type: Boolean, default: false },
    audience: {
      type: String,
      enum: ['GENERAL', 'CARDIOLOGIST', 'GP', 'PEDIATRICIAN', 'GYNAECOLOGIST', 'CUSTOM'],
      default: 'GENERAL'
    },
    origin: { type: String, enum: ['MANUAL', 'AI_DRAFT'], default: 'MANUAL' },
    theme: { type: themeSchema, default: () => ({}) },
    sections: { type: [sectionSchema], default: [] },
    slides: { type: [slideSchema], default: [] },
    qualityReport: {
      score: { type: Number, default: null },
      checkedAt: { type: Date, default: null },
      checks: { type: [qualityCheckSchema], default: [] }
    },
    publishedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

productPresentationSchema.index({ companyId: 1, productId: 1, status: 1 });
productPresentationSchema.index({ companyId: 1, productId: 1, isDefault: 1 });

productPresentationSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('ProductPresentation', productPresentationSchema);
module.exports.SLIDE_TYPES = SLIDE_TYPES;
module.exports.SECTION_KEYS = SECTION_KEYS;
module.exports.PRESENTATION_STATUS = PRESENTATION_STATUS;
module.exports.COMPONENT_TYPES = COMPONENT_TYPES;
