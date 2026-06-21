const env = require('../config/env');

/**
 * Resolve effective media flags. Per-company overrides (Company.*Enabled) win
 * over env defaults when set (non-null); otherwise the env flag is used. This
 * lets a tenant be opted into media independently of the global env flag.
 */
function getMediaFlags(company) {
  const isOn = (v) => String(v) === '1';
  // company override wins when it is an explicit boolean; null = inherit env.
  const resolve = (override, envFlag) =>
    typeof override === 'boolean' ? override : isOn(envFlag);

  const enableMediaUpload = resolve(
    company && company.mediaUploadEnabled,
    env.ENABLE_MEDIA_UPLOAD
  );
  return {
    enableMediaUpload,
    enableVisitPhotos:
      enableMediaUpload &&
      resolve(company && company.visitPhotosEnabled, env.ENABLE_VISIT_PHOTOS),
    enableExpenseReceipts:
      enableMediaUpload &&
      resolve(company && company.expenseReceiptsEnabled, env.ENABLE_EXPENSE_RECEIPTS),
    enableProductMedia:
      enableMediaUpload &&
      resolve(company && company.productMediaEnabled, env.ENABLE_PRODUCT_MEDIA),
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
