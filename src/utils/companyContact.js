const fs = require('fs');
const path = require('path');
const ApiError = require('./ApiError');

const LOGO_DIR = path.join(__dirname, '../../uploads/company-logos');
const LOGO_PUBLIC_PREFIX = '/company-logos';
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/**
 * Normalize company phone fields.
 * Accepts `phones` (array) and/or legacy `phone` (string).
 * Returns { phones, phone } where phone is the first number (legacy consumers).
 */
function normalizePhones(payload = {}) {
  let phones = [];
  if (Array.isArray(payload.phones)) {
    phones = payload.phones.map((p) => String(p || '').trim()).filter(Boolean);
  } else if (payload.phone != null && String(payload.phone).trim()) {
    phones = [String(payload.phone).trim()];
  }
  // Deduplicate while preserving order
  const seen = new Set();
  phones = phones.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  return {
    phones,
    phone: phones[0] || ''
  };
}

/** Resolve phones from a company document for display/PDF. */
function companyPhoneList(company) {
  if (!company) return [];
  if (Array.isArray(company.phones) && company.phones.length) {
    return company.phones.map((p) => String(p || '').trim()).filter(Boolean);
  }
  if (company.phone) return [String(company.phone).trim()].filter(Boolean);
  return [];
}

function ensureLogoDir() {
  if (!fs.existsSync(LOGO_DIR)) {
    fs.mkdirSync(LOGO_DIR, { recursive: true });
  }
}

function clearLogoFiles(companyId) {
  ensureLogoDir();
  const prefix = `${String(companyId)}.`;
  for (const name of fs.readdirSync(LOGO_DIR)) {
    if (name.startsWith(prefix)) {
      try {
        fs.unlinkSync(path.join(LOGO_DIR, name));
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Persist a company logo from a data-URL (or pass through an existing public path).
 * - null / '' → clear logo (returns null)
 * - data:image/...;base64,... → write file, return public path
 * - /company-logos/... or http(s) URL → keep as-is
 * - undefined → no change (caller should skip)
 */
async function persistCompanyLogo(companyId, logoInput) {
  if (logoInput === undefined) return undefined;
  if (logoInput === null || logoInput === '') {
    clearLogoFiles(companyId);
    return null;
  }

  const value = String(logoInput).trim();
  if (!value) {
    clearLogoFiles(companyId);
    return null;
  }

  if (value.startsWith(LOGO_PUBLIC_PREFIX + '/') || /^https?:\/\//i.test(value)) {
    return value;
  }

  // PDFKit embeds PNG/JPEG reliably; keep the allow-list aligned with invoice rendering.
  const match = value.match(/^data:(image\/(png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    throw new ApiError(400, 'Invalid company logo. Upload a PNG or JPG image.');
  }

  const extRaw = match[2].toLowerCase();
  const ext = extRaw === 'jpeg' ? 'jpg' : extRaw;
  const buf = Buffer.from(match[3].replace(/\s/g, ''), 'base64');
  if (!buf.length) throw new ApiError(400, 'Invalid company logo data.');
  if (buf.length > MAX_LOGO_BYTES) {
    throw new ApiError(413, 'Logo too large (max 2 MB).');
  }

  ensureLogoDir();
  clearLogoFiles(companyId);
  const filename = `${companyId}.${ext}`;
  fs.writeFileSync(path.join(LOGO_DIR, filename), buf);
  return `${LOGO_PUBLIC_PREFIX}/${filename}`;
}

/**
 * Resolve a company.logo value to a local filesystem path for PDFKit, or null.
 */
function resolveCompanyLogoFile(logo) {
  if (!logo || typeof logo !== 'string') return null;
  const value = logo.trim();
  if (!value) return null;

  if (value.startsWith(LOGO_PUBLIC_PREFIX + '/')) {
    const filePath = path.join(LOGO_DIR, path.basename(value));
    return fs.existsSync(filePath) ? filePath : null;
  }

  if (value.startsWith('data:image/')) {
    const match = value.match(/^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) return null;
    try {
      return Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    } catch {
      return null;
    }
  }

  // Absolute local path fallback
  if (path.isAbsolute(value) && fs.existsSync(value)) return value;

  return null;
}

module.exports = {
  normalizePhones,
  companyPhoneList,
  persistCompanyLogo,
  resolveCompanyLogoFile,
  LOGO_DIR,
  LOGO_PUBLIC_PREFIX
};
