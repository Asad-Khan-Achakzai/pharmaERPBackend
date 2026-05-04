/**
 * Doctor bulk-import helpers.
 * Pure functions: header normalization, row cleaning, and dedupe-key building.
 * Keep this file dependency-light — no DB / no Joi.
 */

/** Canonical fields we accept on import. Order is the column order used by the template. */
const FIELDS = [
  'name',
  'doctorCode',
  'specialization',
  'qualification',
  'designation',
  'gender',
  'mobileNo',
  'phone',
  'email',
  'zone',
  'doctorBrick',
  'frequency',
  'grade',
  'locationName',
  'address',
  'city',
  'pmdcRegistration',
  'patientCount'
];

/** UI-facing label per field — used in the downloadable template. */
const FIELD_LABELS = {
  name: 'Doctor Name',
  doctorCode: 'Doctor Code',
  specialization: 'Specialty',
  qualification: 'Qualification',
  designation: 'Designation',
  gender: 'Gender',
  mobileNo: 'Mobile No',
  phone: 'Phone',
  email: 'Email',
  zone: 'Zone',
  doctorBrick: 'Doctor Brick',
  frequency: 'Frequency',
  grade: 'Grade',
  locationName: 'Location Name',
  address: 'Address',
  city: 'City',
  pmdcRegistration: 'PMDC # / Duplicate / SMART',
  patientCount: 'No of patients'
};

/** Required (server-side) fields. We mirror the doctor model: only `name` is required. */
const REQUIRED_FIELDS = ['name'];

/**
 * Aliases grouped by canonical field. We intentionally keep this small and explicit;
 * users can re-map manually in the UI when the file uses an exotic header.
 */
const HEADER_SYNONYMS = {
  name: ['doctor name', 'name', 'doctor', 'doctor full name', 'physician'],
  doctorCode: ['doctor code', 'code', 'doc code', 'mio code'],
  specialization: ['specialty', 'speciality', 'specialization', 'specialisation'],
  qualification: ['qualification', 'qualifications', 'degree'],
  designation: ['designation', 'title'],
  gender: ['gender', 'sex'],
  mobileNo: ['mobile', 'mobile no', 'mobile number', 'cell', 'cell no', 'cellphone'],
  phone: ['phone', 'phone no', 'land line', 'landline', 'tel'],
  email: ['email', 'e-mail', 'mail'],
  zone: ['zone', 'territory', 'region'],
  doctorBrick: ['doctor brick', 'brick'],
  frequency: ['frequency', 'visit frequency', 'call frequency'],
  grade: ['grade', 'class'],
  locationName: ['location name', 'location', 'hospital', 'clinic'],
  address: ['address', 'street', 'street address'],
  city: ['city', 'town'],
  pmdcRegistration: ['pmdc', 'pmdc#', 'pmdc no', 'pmdc number', 'pmdc/duplicate/smart', 'pmdc # / duplicate / smart'],
  patientCount: ['no of patients', 'patient count', 'patients', 'num patients']
};

const normalizeHeader = (h) =>
  String(h == null ? '' : h)
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/[^a-z0-9 #/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** @returns mapping {field: headerName | null} suggested by header text. */
const inferMapping = (headers) => {
  const norm = headers.map((h) => ({ raw: h, n: normalizeHeader(h) }));
  const used = new Set();
  const mapping = {};
  for (const f of FIELDS) {
    mapping[f] = null;
    const aliases = HEADER_SYNONYMS[f] || [];
    let pick = null;
    for (const a of aliases) {
      const target = normalizeHeader(a);
      pick = norm.find((h) => h.n === target && !used.has(h.raw));
      if (pick) break;
    }
    if (!pick) {
      // Soft fallback: contains alias token (e.g. "Mobile No (Primary)").
      for (const a of aliases) {
        const target = normalizeHeader(a);
        pick = norm.find((h) => h.n.includes(target) && !used.has(h.raw));
        if (pick) break;
      }
    }
    if (pick) {
      mapping[f] = pick.raw;
      used.add(pick.raw);
    }
  }
  return mapping;
};

const cleanString = (v) => {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
};

const cleanGender = (v) => {
  const s = cleanString(v).toLowerCase();
  if (!s) return '';
  if (s.startsWith('m')) return 'Male';
  if (s.startsWith('f')) return 'Female';
  if (s === 'other' || s === 'others' || s === 'o') return 'Other';
  return ''; // unknown values are dropped silently — never block the row
};

const cleanPhone = (v) => {
  const s = cleanString(v);
  if (!s) return '';
  const plus = s.startsWith('+');
  const digits = s.replace(/\D+/g, '');
  if (!digits) return '';
  return plus ? `+${digits}` : digits;
};

const cleanPatientCount = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
};

/** Keys used for in-file + DB dedupe. Empty key means "row contributes nothing for dedupe by that strategy". */
const dedupeKeysFor = (doc) => {
  const codeKey = doc.doctorCode ? doc.doctorCode.toLowerCase() : '';
  const nameMobile =
    doc.name && doc.mobileNo
      ? `${doc.name.toLowerCase()}|${doc.mobileNo}`
      : '';
  return { codeKey, nameMobile };
};

/**
 * Build a doctor payload from raw row + mapping.
 * Returns { payload, blank: true } if the row has no usable data, so callers can skip it.
 */
const buildDoctorPayload = (rowObj, mapping) => {
  const get = (field) => {
    const header = mapping[field];
    if (!header) return undefined;
    const cell = rowObj[header];
    return cell;
  };

  const payload = {
    name: cleanString(get('name')),
    doctorCode: cleanString(get('doctorCode')),
    specialization: cleanString(get('specialization')),
    qualification: cleanString(get('qualification')),
    designation: cleanString(get('designation')),
    gender: cleanGender(get('gender')),
    mobileNo: cleanPhone(get('mobileNo')),
    phone: cleanPhone(get('phone')),
    email: cleanString(get('email')).toLowerCase(),
    zone: cleanString(get('zone')),
    doctorBrick: cleanString(get('doctorBrick')),
    frequency: cleanString(get('frequency')),
    grade: cleanString(get('grade')),
    locationName: cleanString(get('locationName')),
    address: cleanString(get('address')),
    city: cleanString(get('city')),
    pmdcRegistration: cleanString(get('pmdcRegistration')),
    patientCount: cleanPatientCount(get('patientCount'))
  };

  // A row is "blank" if every textual field is empty AND patientCount is null.
  const blank =
    !payload.name &&
    Object.entries(payload).every(([k, v]) => {
      if (k === 'patientCount') return v == null;
      return v == null || v === '';
    });

  return { payload, blank };
};

module.exports = {
  FIELDS,
  FIELD_LABELS,
  REQUIRED_FIELDS,
  HEADER_SYNONYMS,
  inferMapping,
  buildDoctorPayload,
  dedupeKeysFor,
  cleanString,
  cleanPhone,
  cleanGender,
  cleanPatientCount
};
