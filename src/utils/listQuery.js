const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const businessTime = require('./businessTime');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Express / qs can return repeated keys as arrays; normalize to a scalar string. */
const qScalar = (v) => {
  if (v === undefined || v === null) return '';
  return String(Array.isArray(v) ? v[0] : v).trim();
};

/**
 * From query: YYYY-MM-DD (interpreted in company IANA TZ) or ISO instant (UTC).
 * `bound` is only used for bare YYYY-MM-DD strings.
 * @param {string} ianaTimeZone
 */
const queryDateBound = (raw, bound, ianaTimeZone) => {
  const zone = businessTime.requireCompanyIanaZone(ianaTimeZone);
  const s = qScalar(raw);
  if (!s) return null;
  if (s.length > 10 || s.includes('T')) {
    const dt = DateTime.fromISO(s, { zone: 'utc' });
    if (!dt.isValid) return null;
    return dt.toJSDate();
  }
  return bound === 'end'
    ? businessTime.filterUpperBoundUtc(s, zone)
    : businessTime.filterLowerBoundUtc(s, zone);
};

/** Mutates filter: `createdAt` range from query.from / query.to */
const applyCreatedAtRangeFromQuery = (filter, query, ianaTimeZone) => {
  const fromRaw = query.from;
  const toRaw = query.to;
  if (!fromRaw && !toRaw) return;
  const zone = businessTime.requireCompanyIanaZone(ianaTimeZone);
  filter.createdAt = {};
  if (fromRaw) {
    const t0 = queryDateBound(fromRaw, 'start', zone);
    if (t0) filter.createdAt.$gte = t0;
  }
  if (toRaw) {
    const t1 = queryDateBound(toRaw, 'end', zone);
    if (t1) filter.createdAt.$lte = t1;
  }
  if (!Object.keys(filter.createdAt).length) delete filter.createdAt;
};

/** Mutates filter: `createdBy` ObjectId from query.createdBy */
const applyCreatedByFromQuery = (filter, query) => {
  const raw = qScalar(query.createdBy);
  if (raw && mongoose.Types.ObjectId.isValid(raw)) {
    filter.createdBy = new mongoose.Types.ObjectId(raw);
  }
};

/**
 * Mutates filter: arbitrary date field (e.g. `date`, `weekStartDate`) from query.from / query.to
 * @param {string} [ianaTimeZone]
 */
const applyDateFieldRangeFromQuery = (filter, query, fieldName = 'date', ianaTimeZone) => {
  const fromRaw = query.from;
  const toRaw = query.to;
  if (!fromRaw && !toRaw) return;
  const zone = businessTime.requireCompanyIanaZone(ianaTimeZone);
  filter[fieldName] = {};
  if (fromRaw) {
    const t0 = queryDateBound(fromRaw, 'start', zone);
    if (t0) filter[fieldName].$gte = t0;
  }
  if (toRaw) {
    const t1 = queryDateBound(toRaw, 'end', zone);
    if (t1) filter[fieldName].$lte = t1;
  }
  if (!Object.keys(filter[fieldName]).length) delete filter[fieldName];
};

module.exports = {
  escapeRegex,
  qScalar,
  queryDateBound,
  applyCreatedAtRangeFromQuery,
  applyCreatedByFromQuery,
  applyDateFieldRangeFromQuery
};
