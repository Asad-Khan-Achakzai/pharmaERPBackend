const ApiError = require('./ApiError');
const { DateTime } = require('luxon');
const { requireCompanyIanaZone, businessDayKeyFromUtcInstant, businessDayToUtcRange, isYmd } = require('./businessTime');

/** Max calendar days in the past for order/delivery business dates (set ORDER_BACKDATE_MAX_DAYS). */
const msPerDay = 86400000;

const getMaxBackdateDays = () => {
  const n = parseInt(process.env.ORDER_BACKDATE_MAX_DAYS ?? '30', 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
};

const normalizeCandidateDayKey = (candidate, timeZone) => {
  if (typeof candidate === 'string' && isYmd(candidate)) return candidate.trim();
  return businessDayKeyFromUtcInstant(candidate, timeZone);
};

const normalizeReferenceDayKey = (referenceNow, timeZone) =>
  businessDayKeyFromUtcInstant(referenceNow, timeZone);

/**
 * @param {Date|string|number} candidate
 * @param {Date|string|number} referenceNow
 * @param {string} timeZone — company IANA zone (request context); tests may pass e.g. "UTC".
 */
const assertValidBackdateWindow = (candidate, referenceNow, timeZone) => {
  const tz = requireCompanyIanaZone(timeZone, 'Company timezone is required for order date validation.');
  const cKey = normalizeCandidateDayKey(candidate, tz);
  const nKey = normalizeReferenceDayKey(referenceNow, tz);

  const cStart = DateTime.fromISO(cKey, { zone: tz }).startOf('day');
  const nStart = DateTime.fromISO(nKey, { zone: tz }).startOf('day');
  if (!cStart.isValid || !nStart.isValid) throw new ApiError(400, 'Invalid business date');

  if (cStart > nStart) throw new ApiError(400, 'Business date cannot be in the future');

  const maxDays = getMaxBackdateDays();
  const daysBack = nStart.diff(cStart, 'days').days;
  if (daysBack > maxDays) {
    throw new ApiError(400, `Business date cannot be more than ${maxDays} days in the past`);
  }
};

/**
 * Delivery / order coherence: delivery business day must not be before order business day.
 * @param {Date|string|number} deliveryInstant
 * @param {Date|string|number} orderAnchorInstant — orderDate or createdAt
 * @param {string} timeZone
 */
const assertDeliveryNotBeforeOrder = (deliveryInstant, orderAnchorInstant, timeZone) => {
  const tz = requireCompanyIanaZone(timeZone, 'Company timezone is required for delivery vs order dates.');
  const dKey = normalizeCandidateDayKey(deliveryInstant, tz);
  const oKey = normalizeCandidateDayKey(orderAnchorInstant, tz);
  const d0 = DateTime.fromISO(dKey, { zone: tz }).startOf('day');
  const o0 = DateTime.fromISO(oKey, { zone: tz }).startOf('day');
  if (!d0.isValid || !o0.isValid) {
    throw new ApiError(400, 'Invalid date for delivery vs order comparison');
  }
  if (d0 < o0) throw new ApiError(400, 'Delivery date cannot be before order date');
};

/**
 * True if business day of `d` is strictly before business day of `reference`.
 * @param {Date|string|number} d
 * @param {Date|string|number} reference
 * @param {string} timeZone
 */
const isStrictlyBackdatedCalendarDay = (d, reference, timeZone) => {
  const tz = requireCompanyIanaZone(timeZone, 'Company timezone is required for backdate checks.');
  const dk = normalizeCandidateDayKey(d, tz);
  const rk = normalizeCandidateDayKey(reference, tz);
  return dk < rk;
};

module.exports = {
  normalizeCandidateDayKey,
  getMaxBackdateDays,
  assertValidBackdateWindow,
  assertDeliveryNotBeforeOrder,
  isStrictlyBackdatedCalendarDay,
  /** Parses order/delivery input: YYYY-MM-DD → start of that business day (UTC); else ISO instant (UTC). */
  businessInstantFromYmdOrInstant: (input, timeZone) => {
    const tz = requireCompanyIanaZone(timeZone, 'Company timezone is required for order/delivery instants.');
    if (typeof input === 'string' && isYmd(input)) {
      return businessDayToUtcRange(input, tz).$gte;
    }
    if (input instanceof Date) {
      if (Number.isNaN(input.getTime())) throw new ApiError(400, 'Invalid date');
      return DateTime.fromJSDate(input, { zone: 'utc' }).toJSDate();
    }
    const dt = DateTime.fromISO(String(input), { zone: 'utc' });
    if (!dt.isValid) throw new ApiError(400, 'Invalid date');
    return dt.toJSDate();
  }
};
