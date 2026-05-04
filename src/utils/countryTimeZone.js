const { Info } = require('luxon');
const ApiError = require('./ApiError');

const COUNTRY_TO_TIMEZONE = {
  PK: 'Asia/Karachi',
  AE: 'Asia/Dubai',
  UK: 'Europe/London',
  US: 'America/New_York'
};

const NAME_TO_CODE = {
  PAKISTAN: 'PK',
  UAE: 'AE',
  'UNITED ARAB EMIRATES': 'AE',
  ENGLAND: 'UK',
  'UNITED KINGDOM': 'UK',
  'UNITED STATES': 'US',
  USA: 'US'
};

/**
 * @param {unknown} country
 * @returns {string} ISO 3166-1 alpha-2 when mappable, else ''.
 */
const normalizeCountryCode = (country) => {
  if (country == null) return '';
  const s = String(country).trim();
  if (!s) return '';
  const upper = s.toUpperCase();
  if (upper.length === 2) return upper;
  return NAME_TO_CODE[upper] || '';
};

/**
 * Resolution order: explicit IANA `timeZone` → mapped default from `country` → reject.
 * No silent UTC for tenant onboarding.
 *
 * @param {{ timeZone?: string|null, country?: string|null }} input
 * @returns {string} validated IANA zone
 */
const resolveCompanyTimeZone = ({ timeZone, country } = {}) => {
  const tzRaw = timeZone != null ? String(timeZone).trim() : '';
  if (tzRaw) {
    if (!Info.isValidIANAZone(tzRaw)) {
      throw new ApiError(400, 'Invalid IANA timezone. Use a standard IANA identifier (e.g. Asia/Karachi).');
    }
    return tzRaw;
  }

  const code = normalizeCountryCode(country);
  const mapped = code ? COUNTRY_TO_TIMEZONE[code] : null;
  if (mapped && Info.isValidIANAZone(mapped)) {
    return mapped;
  }

  throw new ApiError(
    400,
    'Timezone is required. Send a valid IANA timeZone or a supported country (PK, AE, UK, US, or e.g. Pakistan).'
  );
};

module.exports = {
  COUNTRY_TO_TIMEZONE,
  NAME_TO_CODE,
  normalizeCountryCode,
  resolveCompanyTimeZone
};
