const mongoose = require('mongoose');

/**
 * Optional media subsystem (visit photos, attendance selfies, expense
 * receipts, payment receipts, product visuals).
 *
 * Per the "Always-Present UI, Optional Backend Capability" rule (see plan
 * §6.6) this collection only fills up when the corresponding ENABLE_* env
 * flags are on. Core flows must continue to work with zero rows here.
 */
const MEDIA_KINDS = [
  'VISIT_PHOTO',
  'ATTENDANCE_SELFIE',
  'EXPENSE_RECEIPT',
  'PAYMENT_RECEIPT',
  'PRODUCT_VISUAL',
  'USER_AVATAR',
  'DOCTOR_PHOTO',
  'PHARMACY_PHOTO',
  'SUPPLIER_PHOTO',
  'DISTRIBUTOR_PHOTO',
  'OTHER'
];

/** Resources an asset can be linked to. Source of truth for entity images. */
const MEDIA_RESOURCES = [
  'visits',
  'attendance',
  'expenses',
  'collections',
  'payments',
  'products',
  'users',
  'doctors',
  'pharmacies',
  'suppliers',
  'distributors'
];

const RETENTION_CLASSES = ['TEMPORARY', 'PERMANENT'];

const mediaAssetSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    kind: { type: String, enum: MEDIA_KINDS, required: true, index: true },
    bucket: { type: String, required: true },
    key: { type: String, required: true },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    status: {
      type: String,
      enum: ['PENDING_UPLOAD', 'READY', 'FAILED', 'DELETING'],
      default: 'PENDING_UPLOAD',
      index: true
    },
    /**
     * Retention classification (set at finalize from company policy + kind).
     * PERMANENT assets are never selected by the cleanup job.
     */
    retentionClass: {
      type: String,
      enum: RETENTION_CLASSES,
      default: 'PERMANENT',
      index: true
    },
    /** When a TEMPORARY asset becomes eligible for deletion. null = never delete. */
    expiresAt: { type: Date, default: null },
    /** Terminal marker once the object is removed from R2. */
    deletedAt: { type: Date, default: null },
    /** Cleanup bookkeeping for idempotent + retry-safe deletion. */
    deleteAttempts: { type: Number, default: 0 },
    deleteAttemptedAt: { type: Date, default: null },
    lastDeleteError: { type: String, default: null },
    /** Optional back-reference once linked from a core resource (visit, expense, ...). */
    linkedTo: {
      type: new mongoose.Schema(
        {
          resource: {
            type: String,
            enum: MEDIA_RESOURCES,
            required: true
          },
          id: { type: mongoose.Schema.Types.ObjectId, required: true }
        },
        { _id: false }
      ),
      default: null
    },
    /** Free-form metadata (exif, sha256, location, etc). */
    meta: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

mediaAssetSchema.index({ companyId: 1, kind: 1, status: 1 });
mediaAssetSchema.index({ companyId: 1, 'linkedTo.resource': 1, 'linkedTo.id': 1 });
mediaAssetSchema.index({ retentionClass: 1, expiresAt: 1, status: 1 });

module.exports = mongoose.model('MediaAsset', mediaAssetSchema);
module.exports.MEDIA_KINDS = MEDIA_KINDS;
module.exports.MEDIA_RESOURCES = MEDIA_RESOURCES;
module.exports.RETENTION_CLASSES = RETENTION_CLASSES;
