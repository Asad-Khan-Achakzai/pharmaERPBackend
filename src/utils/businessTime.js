const { DateTime, Info } = require('luxon');
const ApiError = require('./ApiError');

const DEFAULT_TZ = 'UTC';
const MS_PER_DAY = 86400000;
const MAX_REPORT_RANGE_DAYS = 800;

const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(String(s).trim());

const ONBOARDING_TZ_MSG = 'Company timezone is not configured. Onboarding incomplete.';

/**
 * Validated IANA zone for tenant request context. No silent UTC fallback.
 * @param {unknown} tz
 * @param {string} [message]
 * @returns {string}
 */
const requireCompanyIanaZone = (tz, message = ONBOARDING_TZ_MSG) => {
  const z = tz != null ? String(tz).trim() : '';
  if (!z || !Info.isValidIANAZone(z)) {
    throw new ApiError(422, message);
  }
  return z;
};

const getTimeZone = (company) => {
  if (!company) {
    throw new ApiError(422, ONBOARDING_TZ_MSG);
  }
  return requireCompanyIanaZone(company.timeZone);
};

const assertValidIanaZone = (tz, label = 'timeZone') => {
  const z = String(tz || '').trim();
  if (!Info.isValidIANAZone(z)) {
    throw new ApiError(400, `Invalid IANA timezone for ${label}: ${tz}`);
  }
  return z;
};

/** Wall-clock instant in UTC (for storing “now” / timestamps in Mongo). */
const utcNow = () => DateTime.utc().toJSDate();

const utcNowIso = () => DateTime.utc().toISO();

/**
 * @param {Date|string|number} date
 * @param {string} tz
 * @returns {import('luxon').DateTime}
 */
const toBusinessTime = (date, tz) => {
  const zone = requireCompanyIanaZone(tz);
  const js = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(js.getTime())) {
    throw new ApiError(400, 'Invalid date');
  }
  return DateTime.fromJSDate(js, { zone: 'utc' }).setZone(zone);
};

const nowInBusinessTime = (tz) => DateTime.now().setZone(requireCompanyIanaZone(tz));

/**
 * Inclusive UTC bounds for one business calendar day (YYYY-MM-DD) in `tz`.
 * @returns {{ $gte: Date, $lte: Date }}
 */
const businessDayToUtcRange = (dateStr, tz) => {
  const s = String(dateStr).trim();
  if (!isYmd(s)) {
    throw new ApiError(400, `Expected business date YYYY-MM-DD, got: ${dateStr}`);
  }
  const zone = requireCompanyIanaZone(tz);
  const start = DateTime.fromISO(s, { zone });
  if (!start.isValid) {
    throw new ApiError(400, `Invalid business date: ${dateStr}`);
  }
  const end = start.endOf('day');
  return { $gte: start.toUTC().toJSDate(), $lte: end.toUTC().toJSDate() };
};

/** Start of business day as stored “date anchor” (same as `$gte` from businessDayToUtcRange). */
const businessDayStartUtc = (dateStr, tz) => businessDayToUtcRange(dateStr, tz).$gte;

const getBusinessMonthKey = (date, tz) => toBusinessTime(date, tz).toFormat('yyyy-MM');

const businessDayKeyFromUtcInstant = (date, tz) => toBusinessTime(date, tz).toFormat('yyyy-MM-dd');

/**
 * Current calendar month in company TZ, as UTC inclusive range for Mongo queries.
 * @returns {{ $gte: Date, $lte: Date }}
 */
const defaultBusinessMonthUtcRange = (tz) => {
  const z = requireCompanyIanaZone(tz);
  const now = DateTime.now().setZone(z);
  const start = now.startOf('month');
  const end = now.endOf('month');
  return { $gte: start.toUTC().toJSDate(), $lte: end.toUTC().toJSDate() };
};

/**
 * Both from and to required (dashboard-style).
 * @param {string} fromYmd
 * @param {string} toYmd
 * @returns {{ $gte: Date, $lte: Date }}
 */
const coalesceBusinessDateRangeFromYmd = (fromYmd, toYmd, tz) => {
  if (!fromYmd || !toYmd) {
    throw new ApiError(400, 'from and to must both be provided for a date range');
  }
  const a = businessDayToUtcRange(fromYmd, tz);
  const b = businessDayToUtcRange(toYmd, tz);
  const start = a.$gte;
  const end = b.$lte;
  if (start > end) throw new ApiError(400, 'from must be on or before to');
  const days = Math.ceil((end.getTime() - start.getTime()) / MS_PER_DAY);
  if (days > MAX_REPORT_RANGE_DAYS) {
    throw new ApiError(400, 'Date range exceeds maximum allowed');
  }
  return { $gte: start, $lte: end };
};

const periodPayloadFromUtcRange = (range, tz) => {
  if (!range || !range.$gte || !range.$lte) return undefined;
  const z = requireCompanyIanaZone(tz);
  return {
    from: businessDayKeyFromUtcInstant(range.$gte, z),
    to: businessDayKeyFromUtcInstant(range.$lte, z)
  };
};

/**
 * API filter: YYYY-MM-DD → business bounds; ISO (length > 10 or contains T) → instant in UTC.
 */
const filterLowerBoundUtc = (raw, tz) => {
  const s = String(raw).trim();
  if (!s) return null;
  if (isYmd(s)) return businessDayToUtcRange(s, tz).$gte;
  const dt = DateTime.fromISO(s, { zone: 'utc' });
  if (!dt.isValid) return null;
  return dt.toJSDate();
};

const filterUpperBoundUtc = (raw, tz) => {
  const s = String(raw).trim();
  if (!s) return null;
  if (isYmd(s)) return businessDayToUtcRange(s, tz).$lte;
  const dt = DateTime.fromISO(s, { zone: 'utc' });
  if (!dt.isValid) return null;
  return dt.toJSDate();
};

/** Mutates `match`: sets `match[field]` to `{ $gte, $lte }` fragments when from/to provided. */
const applyOptionalUtcRange = (match, field, fromRaw, toRaw, tz) => {
  if (!fromRaw && !toRaw) return;
  const z = requireCompanyIanaZone(tz);
  const dr = {};
  if (fromRaw) {
    const lo = filterLowerBoundUtc(fromRaw, z);
    if (!lo) throw new ApiError(400, 'Invalid from date');
    dr.$gte = lo;
  }
  if (toRaw) {
    const hi = filterUpperBoundUtc(toRaw, z);
    if (!hi) throw new ApiError(400, 'Invalid to date');
    dr.$lte = hi;
  }
  match[field] = dr;
};

const mongoDateToStringDay = (fieldPath, tz) => ({
  $dateToString: { format: '%Y-%m-%d', date: fieldPath, timezone: requireCompanyIanaZone(tz) }
});

const mongoDateToStringMonth = (fieldPath, tz) => ({
  $dateToString: { format: '%Y-%m', date: fieldPath, timezone: requireCompanyIanaZone(tz) }
});

/**
 * Last N full calendar months in company TZ including current month → UTC range + expected month keys.
 * @returns {{ dateRange: { $gte: Date, $lte: Date }, monthKeys: string[] }}
 */
const lastNBusinessMonthsUtcRangeAndKeys = (tz, nMonths) => {
  const n = Math.min(36, Math.max(1, parseInt(nMonths, 10) || 12));
  const z = requireCompanyIanaZone(tz);
  const now = DateTime.now().setZone(z);
  const start = now.minus({ months: n - 1 }).startOf('month');
  const end = now.endOf('month');
  const monthKeys = [];
  let cur = start;
  for (let i = 0; i < n; i += 1) {
    monthKeys.push(cur.toFormat('yyyy-MM'));
    cur = cur.plus({ months: 1 });
  }
  return {
    dateRange: { $gte: start.toUTC().toJSDate(), $lte: end.toUTC().toJSDate() },
    monthKeys
  };
};

/** All YYYY-MM-DD keys in a calendar month in company TZ. */
const businessMonthYmds = (monthStr, tz) => {
  const z = requireCompanyIanaZone(tz);
  const parts = String(monthStr).trim().split('-').map(Number);
  const Y = parts[0];
  const M = parts[1];
  if (!Y || !M || M < 1 || M > 12) return [];
  let d = DateTime.fromObject({ year: Y, month: M, day: 1 }, { zone: z }).startOf('day');
  const end = d.endOf('month');
  const keys = [];
  while (d <= end) {
    keys.push(d.toISODate());
    d = d.plus({ days: 1 });
  }
  return keys;
};

const businessMinutesSinceMidnight = (tz) => {
  const n = DateTime.now().setZone(requireCompanyIanaZone(tz));
  return n.hour * 60 + n.minute + n.second / 60 + n.millisecond / 60000;
};

const formatHmBusiness = (jsDate, tz) => {
  if (jsDate == null) return null;
  const js = jsDate instanceof Date ? jsDate : new Date(jsDate);
  if (Number.isNaN(js.getTime())) return null;
  return DateTime.fromJSDate(js, { zone: 'utc' })
    .setZone(requireCompanyIanaZone(tz))
    .toFormat('HH:mm');
};

module.exports = {
  DEFAULT_TZ,
  ONBOARDING_TZ_MSG,
  MS_PER_DAY,
  MAX_REPORT_RANGE_DAYS,
  isYmd,
  requireCompanyIanaZone,
  getTimeZone,
  assertValidIanaZone,
  utcNow,
  utcNowIso,
  toBusinessTime,
  nowInBusinessTime,
  businessDayToUtcRange,
  businessDayStartUtc,
  getBusinessMonthKey,
  businessDayKeyFromUtcInstant,
  defaultBusinessMonthUtcRange,
  coalesceBusinessDateRangeFromYmd,
  periodPayloadFromUtcRange,
  filterLowerBoundUtc,
  filterUpperBoundUtc,
  applyOptionalUtcRange,
  mongoDateToStringDay,
  mongoDateToStringMonth,
  lastNBusinessMonthsUtcRangeAndKeys,
  businessMonthYmds,
  businessMinutesSinceMidnight,
  formatHmBusiness
};
