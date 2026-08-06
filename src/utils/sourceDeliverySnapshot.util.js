/**
 * Immutable source-delivery snapshot for return / amendment lines (reporting).
 */
const { getBusinessMonthKey, requireCompanyIanaZone } = require('./businessTime');

/**
 * @param {object|null|undefined} delivery - DeliveryRecord (or lean) with _id, deliveredAt, invoiceNumber
 * @param {string} timeZone - company IANA zone
 * @returns {{
 *   sourceDeliveryId: import('mongoose').Types.ObjectId|null,
 *   sourceDeliveredAt: Date|null,
 *   sourceDeliveryYm: string|null,
 *   sourceInvoiceNumber: string
 * }}
 */
const buildSourceDeliverySnapshot = (delivery, timeZone) => {
  if (!delivery?._id || !delivery.deliveredAt) {
    return {
      sourceDeliveryId: null,
      sourceDeliveredAt: null,
      sourceDeliveryYm: null,
      sourceInvoiceNumber: ''
    };
  }
  const tz = requireCompanyIanaZone(timeZone);
  return {
    sourceDeliveryId: delivery._id,
    sourceDeliveredAt: new Date(delivery.deliveredAt),
    sourceDeliveryYm: getBusinessMonthKey(delivery.deliveredAt, tz),
    sourceInvoiceNumber: delivery.invoiceNumber ? String(delivery.invoiceNumber) : ''
  };
};

/**
 * Classify credit vs event period using persisted (or reconstructed) sourceDeliveryYm.
 * @returns {'currentPeriod'|'priorPeriod'|'unclassified'}
 */
const classifySourceDeliveryPeriod = (eventYm, sourceDeliveryYm) => {
  if (!eventYm || !sourceDeliveryYm) return 'unclassified';
  if (sourceDeliveryYm === eventYm) return 'currentPeriod';
  if (sourceDeliveryYm < eventYm) return 'priorPeriod';
  // Source delivery after event (clock skew / bad data) — treat as unclassified
  return 'unclassified';
};

module.exports = {
  buildSourceDeliverySnapshot,
  classifySourceDeliveryPeriod
};
