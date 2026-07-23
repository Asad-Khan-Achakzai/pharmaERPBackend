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

function mimeToExt(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  return null;
}

/**
 * Persist a company logo from a data-URL (or pass through an existing public path).
 * Returns { logo, logoBase64, logoMime } to assign onto the company document.
 * - null / '' → clear logo
 * - data:image/...;base64,... → write file + return DB-backed payload
 * - /company-logos/... → keep path (base64 unchanged — caller should not clear)
 * - undefined → no change (caller should skip)
 */
async function persistCompanyLogo(companyId, logoInput) {
  if (logoInput === undefined) return undefined;
  if (logoInput === null || logoInput === '') {
    clearLogoFiles(companyId);
    return { logo: null, logoBase64: null, logoMime: null };
  }

  const value = String(logoInput).trim();
  if (!value) {
    clearLogoFiles(companyId);
    return { logo: null, logoBase64: null, logoMime: null };
  }

  // Existing public path — leave binary fields alone (return only logo path).
  if (value.startsWith(LOGO_PUBLIC_PREFIX + '/') || /^https?:\/\//i.test(value)) {
    return { logo: value };
  }

  // PDFKit embeds PNG/JPEG reliably; keep the allow-list aligned with invoice rendering.
  const match = value.match(/^data:(image\/(png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    throw new ApiError(400, 'Invalid company logo. Upload a PNG or JPG image.');
  }

  const extRaw = match[2].toLowerCase();
  const ext = extRaw === 'jpeg' ? 'jpg' : extRaw;
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  const base64 = match[3].replace(/\s/g, '');
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) throw new ApiError(400, 'Invalid company logo data.');
  if (buf.length > MAX_LOGO_BYTES) {
    throw new ApiError(413, 'Logo too large (max 2 MB).');
  }

  ensureLogoDir();
  clearLogoFiles(companyId);
  const filename = `${companyId}.${ext}`;
  fs.writeFileSync(path.join(LOGO_DIR, filename), buf);
  return {
    logo: `${LOGO_PUBLIC_PREFIX}/${filename}`,
    logoBase64: base64,
    logoMime: mime
  };
}

/**
 * Apply persistCompanyLogo result onto a mongoose company document.
 */
function applyLogoPersistResult(company, result) {
  if (!result) return;
  if (Object.prototype.hasOwnProperty.call(result, 'logo')) company.logo = result.logo;
  if (Object.prototype.hasOwnProperty.call(result, 'logoBase64')) company.logoBase64 = result.logoBase64;
  if (Object.prototype.hasOwnProperty.call(result, 'logoMime')) company.logoMime = result.logoMime;
}

/**
 * Resolve a company logo to a Buffer or filesystem path for PDFKit.
 * Prefers local file, then MongoDB-backed logoBase64 (works across hosts / ephemeral disks).
 * Accepts either a company doc or a legacy logo string.
 */
function resolveCompanyLogoFile(companyOrLogo) {
  if (!companyOrLogo) return null;

  const isDoc =
    typeof companyOrLogo === 'object' &&
    (companyOrLogo.logo != null || companyOrLogo.logoBase64 != null || companyOrLogo._id != null);
  const logo = isDoc ? companyOrLogo.logo : companyOrLogo;
  const logoBase64 = isDoc ? companyOrLogo.logoBase64 : null;
  const logoMime = isDoc ? companyOrLogo.logoMime : null;
  const companyId = isDoc && companyOrLogo._id ? String(companyOrLogo._id) : null;

  if (logo && typeof logo === 'string') {
    const value = logo.trim();
    if (value.startsWith(LOGO_PUBLIC_PREFIX + '/')) {
      const filePath = path.join(LOGO_DIR, path.basename(value));
      if (fs.existsSync(filePath)) return filePath;
    } else if (value.startsWith('data:image/')) {
      const match = value.match(/^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/i);
      if (match) {
        try {
          return Buffer.from(match[2].replace(/\s/g, ''), 'base64');
        } catch {
          /* fall through */
        }
      }
    } else if (path.isAbsolute(value) && fs.existsSync(value)) {
      return value;
    }
  }

  if (logoBase64 && typeof logoBase64 === 'string') {
    try {
      const buf = Buffer.from(String(logoBase64).replace(/\s/g, ''), 'base64');
      if (!buf.length) return null;
      // Best-effort restore onto disk so /company-logos static preview works again.
      if (companyId) {
        const ext = mimeToExt(logoMime) || 'jpg';
        ensureLogoDir();
        const filePath = path.join(LOGO_DIR, `${companyId}.${ext}`);
        if (!fs.existsSync(filePath)) {
          try {
            fs.writeFileSync(filePath, buf);
          } catch {
            /* ignore restore errors */
          }
        }
      }
      return buf;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Express handler: serve company logo from disk, or from MongoDB if the file is missing.
 */
async function serveCompanyLogo(req, res, next) {
  try {
    const filename = path.basename(String(req.params.filename || ''));
    if (!filename || filename.includes('..')) {
      return res.status(404).end();
    }
    const filePath = path.join(LOGO_DIR, filename);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }

    const id = filename.replace(/\.(png|jpe?g)$/i, '');
    if (!/^[a-f0-9]{24}$/i.test(id)) {
      return res.status(404).end();
    }

    const Company = require('../models/Company');
    const company = await Company.findById(id).select('+logoBase64 +logoMime logo').lean();
    if (!company?.logoBase64) {
      return res.status(404).end();
    }
    const buf = Buffer.from(String(company.logoBase64).replace(/\s/g, ''), 'base64');
    if (!buf.length) return res.status(404).end();

    // Restore file for subsequent static hits.
    try {
      ensureLogoDir();
      fs.writeFileSync(filePath, buf);
    } catch {
      /* ignore */
    }

    res.setHeader('Content-Type', company.logoMime || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(buf);
  } catch (err) {
    return next(err);
  }
}

/** Inline data-URL for browser print clients (prefers MongoDB logoBase64). */
function companyLogoDataUrl(company) {
  if (!company) return null;
  const mime = company.logoMime || 'image/jpeg';
  if (company.logoBase64 && typeof company.logoBase64 === 'string') {
    const b64 = String(company.logoBase64).replace(/\s/g, '');
    if (b64) return `data:${mime};base64,${b64}`;
  }
  const logo = company.logo != null ? String(company.logo).trim() : '';
  if (logo.startsWith('data:image/')) return logo;
  return null;
}

module.exports = {
  normalizePhones,
  companyPhoneList,
  persistCompanyLogo,
  applyLogoPersistResult,
  resolveCompanyLogoFile,
  companyLogoDataUrl,
  serveCompanyLogo,
  LOGO_DIR,
  LOGO_PUBLIC_PREFIX
};
