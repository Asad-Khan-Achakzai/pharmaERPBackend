/**
 * Maps a media `kind` to its retention class and computes the `expiresAt`
 * timestamp from a company's retention policy.
 *
 * Source of truth for "temporary vs permanent":
 *  - VISIT_PHOTO, ATTENDANCE_SELFIE  -> TEMPORARY (visit / check-in evidence)
 *  - EXPENSE_RECEIPT                 -> configurable; default PERMANENT, becomes
 *                                       TEMPORARY only if the company sets
 *                                       expenseReceiptRetentionDays
 *  - PRODUCT_VISUAL, USER_AVATAR,
 *    DOCTOR_PHOTO, PHARMACY_PHOTO    -> PERMANENT always (entity images)
 *  - PAYMENT_RECEIPT, OTHER          -> PERMANENT (no auto-delete)
 *
 * A retention value of null/0 means "never delete" -> PERMANENT with no expiry.
 */

const TEMPORARY_KINDS = new Set(['VISIT_PHOTO', 'ATTENDANCE_SELFIE']);
const CONFIGURABLE_KINDS = new Set(['EXPENSE_RECEIPT']);

function getRetentionDaysForKind(kind, retention) {
  const r = retention || {};
  switch (kind) {
    case 'ATTENDANCE_SELFIE':
      return r.checkinRetentionDays;
    case 'VISIT_PHOTO':
      return r.visitRetentionDays;
    case 'EXPENSE_RECEIPT':
      return r.expenseReceiptRetentionDays;
    default:
      return null;
  }
}

/**
 * @param {string} kind
 * @param {object} company Mongoose Company doc (or plain) with `mediaRetention`
 * @param {Date} [now]
 * @returns {{ retentionClass: 'TEMPORARY'|'PERMANENT', expiresAt: Date|null }}
 */
function resolveRetention(kind, company, now = new Date()) {
  const retention = (company && company.mediaRetention) || {};
  const days = getRetentionDaysForKind(kind, retention);
  const hasWindow = typeof days === 'number' && Number.isFinite(days) && days > 0;

  // Entity images and non-configurable kinds are always permanent.
  const isTemporaryCandidate =
    TEMPORARY_KINDS.has(kind) || CONFIGURABLE_KINDS.has(kind);

  if (isTemporaryCandidate && hasWindow) {
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return { retentionClass: 'TEMPORARY', expiresAt };
  }

  // No window configured (or permanent kind) -> never auto-delete.
  return { retentionClass: 'PERMANENT', expiresAt: null };
}

module.exports = { resolveRetention, getRetentionDaysForKind };
