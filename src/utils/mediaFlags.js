const env = require('../config/env');

/**
 * Resolve effective media flags. Env wins; future iterations can layer
 * Company-level overrides (e.g. Company.featureFlags.mobileMediaEnabled).
 */
function getMediaFlags(_company) {
  const isOn = (v) => String(v) === '1';
  const enableMediaUpload = isOn(env.ENABLE_MEDIA_UPLOAD);
  return {
    enableMediaUpload,
    enableVisitPhotos: enableMediaUpload && isOn(env.ENABLE_VISIT_PHOTOS),
    enableExpenseReceipts: enableMediaUpload && isOn(env.ENABLE_EXPENSE_RECEIPTS),
    enableProductMedia: enableMediaUpload && isOn(env.ENABLE_PRODUCT_MEDIA),
    maxFileSize: env.MEDIA_MAX_FILE_SIZE,
    allowedMime: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
  };
}

function mediaDisabledPayload() {
  return {
    code: 'MEDIA_DISABLED',
    message:
      'Media uploads are not enabled for this deployment. UI remains visible, but actions are no-ops.'
  };
}

module.exports = { getMediaFlags, mediaDisabledPayload };
