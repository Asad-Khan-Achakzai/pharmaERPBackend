const mongoose = require('mongoose');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Express / qs can return repeated keys as arrays; normalize to a scalar string. */
const qScalar = (v) => {
  if (v === undefined || v === null) return '';
  return String(Array.isArray(v) ? v[0] : v).trim();
};

const parseYmdStart = (s) => {
  const parts = String(s).trim().split('-').map((x) => parseInt(x, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [y, m, d] = parts;
  return new Date(y, m - 1, d, 0, 0, 0, 0);
};

const parseYmdEnd = (s) => {
  const parts = String(s).trim().split('-').map((x) => parseInt(x, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [y, m, d] = parts;
  return new Date(y, m - 1, d, 23, 59, 59, 999);
};

/**
 * From query: YYYY-MM-DD or ISO instant.
 * `bound` is only used for bare YYYY-MM-DD strings.
 */
const queryDateBound = (raw, bound) => {
  const s = qScalar(raw);
  if (!s) return null;
  if (s.length > 10 || s.includes('T')) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }
  const d = bound === 'end' ? parseYmdEnd(s) : parseYmdStart(s);
  if (!d || Number.isNaN(d.getTime())) return null;
  return d;
};

/** Mutates filter: `createdAt` range from query.from / query.to */
const applyCreatedAtRangeFromQuery = (filter, query) => {
  const fromRaw = query.from;
  const toRaw = query.to;
  if (!fromRaw && !toRaw) return;
  filter.createdAt = {};
  if (fromRaw) {
    const t0 = queryDateBound(fromRaw, 'start');
    if (t0) filter.createdAt.$gte = t0;
  }
  if (toRaw) {
    const t1 = queryDateBound(toRaw, 'end');
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
 */
const applyDateFieldRangeFromQuery = (filter, query, fieldName = 'date') => {
  const fromRaw = query.from;
  const toRaw = query.to;
  if (!fromRaw && !toRaw) return;
  filter[fieldName] = {};
  if (fromRaw) {
    const t0 = queryDateBound(fromRaw, 'start');
    if (t0) filter[fieldName].$gte = t0;
  }
  if (toRaw) {
    const t1 = queryDateBound(toRaw, 'end');
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
