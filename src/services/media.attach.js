const ApiError = require('../utils/ApiError');
const MediaAsset = require('../models/MediaAsset');
const r2 = require('./storage/r2.client');
const env = require('../config/env');

/**
 * Reusable entity-image helper.
 *
 * MediaAsset.linkedTo is the SINGLE SOURCE OF TRUTH for entity images — no
 * denormalized imageKey/imageUrl is stored on entity models. Use these helpers
 * from any module (products, users, doctors, pharmacies, ...) so upload/link and
 * read logic is never duplicated.
 *
 * Single-image entities (avatar, product, doctor, pharmacy) keep exactly one
 * current asset per {resource, id}: attaching a new one supersedes the previous
 * by classifying it for retention cleanup (marks it deleted-eligible).
 */

const SINGLE_IMAGE_RESOURCES = new Set([
  'users',
  'doctors',
  'pharmacies',
  'products',
  'suppliers',
  'distributors'
]);

/**
 * Attach an uploaded asset to an entity. The asset must belong to the same
 * company + uploader and be READY (finalized).
 *
 * @returns {Promise<object>} the linked asset (lean)
 */
async function attachEntityImage({ companyId, uploadedBy, resource, id, assetId }) {
  if (!MediaAsset.MEDIA_RESOURCES.includes(resource)) {
    throw new ApiError(400, `Unsupported media resource: ${resource}`);
  }
  const asset = await MediaAsset.findOne({ _id: assetId, companyId });
  if (!asset) throw new ApiError(404, 'Asset not found');
  if (uploadedBy && String(asset.uploadedBy) !== String(uploadedBy)) {
    throw new ApiError(403, 'Asset does not belong to the current user');
  }
  if (asset.status !== 'READY') {
    throw new ApiError(409, 'Asset is not finalized yet');
  }

  // Supersede the previous current image for single-image entities so reads
  // resolve exactly one. The old asset is marked for cleanup (soft, via expiry
  // now) without ever auto-deleting permanent assets in place.
  if (SINGLE_IMAGE_RESOURCES.has(resource)) {
    await MediaAsset.updateMany(
      {
        companyId,
        'linkedTo.resource': resource,
        'linkedTo.id': id,
        _id: { $ne: asset._id },
        deletedAt: null
      },
      {
        $set: {
          retentionClass: 'TEMPORARY',
          expiresAt: new Date(),
          linkedTo: null
        }
      }
    );
  }

  asset.linkedTo = { resource, id };
  await asset.save();
  return asset.toObject();
}

/**
 * Batch-resolve current images for a set of entity ids. Returns a Map keyed by
 * entity id string -> { key, url, expiresIn, assetId }. Reads use the existing
 * { companyId, 'linkedTo.resource', 'linkedTo.id' } index and a single signed
 * URL per asset, avoiding N+1 lookups when listing entities.
 *
 * @param {object} params
 * @param {string} params.companyId
 * @param {string} params.resource
 * @param {Array<string>} params.ids
 * @returns {Promise<Map<string, object>>}
 */
async function resolveEntityImages({ companyId, resource, ids }) {
  const result = new Map();
  if (!Array.isArray(ids) || ids.length === 0) return result;

  const assets = await MediaAsset.find({
    companyId,
    'linkedTo.resource': resource,
    'linkedTo.id': { $in: ids },
    status: 'READY',
    deletedAt: null
  })
    .sort({ updatedAt: -1 })
    .lean();

  const r2Active = env.MEDIA_STORAGE_PROVIDER === 'r2' && r2.isConfigured();

  for (const asset of assets) {
    const entityId = String(asset.linkedTo.id);
    // First (most recent) wins for single-image entities.
    if (result.has(entityId)) continue;
    let url = null;
    let expiresIn = 0;
    if (r2Active) {
      const signed = await r2.getPresignedGetUrl({ key: asset.key });
      url = signed.url;
      expiresIn = signed.expiresIn;
    } else if (env.MEDIA_PUBLIC_BASE_URL) {
      url = `${env.MEDIA_PUBLIC_BASE_URL.replace(/\/$/, '')}/${asset.key}`;
    }
    result.set(entityId, {
      assetId: String(asset._id),
      key: asset.key,
      mime: asset.mime,
      url,
      expiresIn
    });
  }

  return result;
}

/**
 * Convenience: resolve a single entity's current image (or null).
 */
async function resolveEntityImage({ companyId, resource, id }) {
  const map = await resolveEntityImages({ companyId, resource, ids: [String(id)] });
  return map.get(String(id)) || null;
}

module.exports = {
  attachEntityImage,
  resolveEntityImages,
  resolveEntityImage,
  SINGLE_IMAGE_RESOURCES
};
