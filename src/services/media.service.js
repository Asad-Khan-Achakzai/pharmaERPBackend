const crypto = require('crypto');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const MediaAsset = require('../models/MediaAsset');
const { getMediaFlags } = require('../utils/mediaFlags');

const SUPPORTED_RESOURCES = ['visits', 'attendance', 'expenses', 'collections', 'payments', 'products'];

function ensureEnabled(req) {
  const flags = getMediaFlags(req.context && req.context.company);
  if (!flags.enableMediaUpload) {
    const err = new ApiError(503, 'Media uploads are not enabled for this deployment.');
    err.errors = [{ code: 'MEDIA_DISABLED' }];
    throw err;
  }
  return flags;
}

function buildKey({ companyId, userId, kind, mime }) {
  const ext = mime.split('/')[1] || 'bin';
  const safeKind = String(kind || 'OTHER').toLowerCase();
  const random = crypto.randomBytes(8).toString('hex');
  return `${companyId}/${safeKind}/${userId}/${Date.now()}-${random}.${ext}`;
}

async function presign({ req, kind, mime, size }) {
  ensureEnabled(req);
  if (!kind || !mime || !size) throw new ApiError(400, 'kind, mime and size are required');
  if (size > env.MEDIA_MAX_FILE_SIZE) {
    throw new ApiError(413, 'File exceeds maximum allowed size');
  }
  const companyId = String(req.companyId);
  const userId = String(req.user.userId);
  const key = buildKey({ companyId, userId, kind, mime });

  const asset = await MediaAsset.create({
    companyId,
    uploadedBy: userId,
    kind,
    bucket: env.MEDIA_BUCKET || 'pharerp-default',
    key,
    mime,
    size,
    status: 'PENDING_UPLOAD'
  });

  // NOTE: When MEDIA_STORAGE_PROVIDER is configured, replace this with a real
  // S3/GCS V4 presign call. For now the URL is null so the mobile client
  // surfaces a clear "media disabled or unconfigured" path.
  return {
    assetId: String(asset._id),
    method: 'PUT',
    key,
    bucket: asset.bucket,
    expiresIn: 0,
    uploadUrl: null,
    note:
      env.MEDIA_STORAGE_PROVIDER === 'none'
        ? 'Storage provider not configured (MEDIA_STORAGE_PROVIDER=none). UI remains visible but uploads are no-ops.'
        : 'Storage provider configured but presigning is not implemented in this build.'
  };
}

async function finalize({ req, assetId, size, mime, width, height }) {
  ensureEnabled(req);
  const asset = await MediaAsset.findOne({
    _id: assetId,
    companyId: req.companyId,
    uploadedBy: req.user.userId
  });
  if (!asset) throw new ApiError(404, 'Asset not found');
  asset.status = 'READY';
  if (size) asset.size = size;
  if (mime) asset.mime = mime;
  if (width) asset.width = width;
  if (height) asset.height = height;
  await asset.save();
  return asset.toObject();
}

async function getSignedUrl({ req, key }) {
  ensureEnabled(req);
  const asset = await MediaAsset.findOne({ key, companyId: req.companyId }).lean();
  if (!asset) throw new ApiError(404, 'Asset not found');
  // Placeholder; replace with provider-specific signed URL.
  return {
    url: env.MEDIA_PUBLIC_BASE_URL
      ? `${env.MEDIA_PUBLIC_BASE_URL.replace(/\/$/, '')}/${asset.key}`
      : null,
    expiresIn: 0,
    asset
  };
}

async function linkToResource({ req, resource, id, assetIds }) {
  ensureEnabled(req);
  if (!SUPPORTED_RESOURCES.includes(resource)) {
    throw new ApiError(400, `Unsupported media resource: ${resource}`);
  }
  if (!Array.isArray(assetIds) || assetIds.length === 0) {
    throw new ApiError(400, 'assetIds must be a non-empty array');
  }
  await MediaAsset.updateMany(
    {
      _id: { $in: assetIds },
      companyId: req.companyId,
      uploadedBy: req.user.userId
    },
    {
      $set: {
        linkedTo: { resource, id }
      }
    }
  );
  const assets = await MediaAsset.find({
    _id: { $in: assetIds },
    companyId: req.companyId
  }).lean();
  return assets;
}

module.exports = {
  ensureEnabled,
  presign,
  finalize,
  getSignedUrl,
  linkToResource,
  SUPPORTED_RESOURCES
};
