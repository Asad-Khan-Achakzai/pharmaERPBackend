/**
 * Bulk doctor import service — additive, isolated.
 * Reuses the canonical create payload validation (createDoctorSchema) for each row,
 * but does NOT touch the existing doctor.service module.
 */
const XLSX = require('xlsx');
const mongoose = require('mongoose');

const Doctor = require('../models/Doctor');
const ApiError = require('../utils/ApiError');
const auditService = require('./audit.service');
const { createDoctorSchema } = require('../validators/doctor.validator');
const {
  FIELDS,
  FIELD_LABELS,
  REQUIRED_FIELDS,
  inferMapping,
  buildDoctorPayload,
  dedupeKeysFor
} = require('../utils/doctorImport.utils');

const MAX_ROWS = 5000;
const PREVIEW_ROWS = 10;
const CHUNK_SIZE = 200;
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB raw xlsx (well under express.json 10mb base64 envelope)
const ERRORS_INLINE_LIMIT = 200;

const decodeFile = (fileBase64) => {
  if (!fileBase64 || typeof fileBase64 !== 'string') {
    throw new ApiError(400, 'fileBase64 is required');
  }
  const stripped = fileBase64.includes(',') ? fileBase64.split(',').pop() : fileBase64;
  let buf;
  try {
    buf = Buffer.from(stripped, 'base64');
  } catch (e) {
    throw new ApiError(400, 'Invalid base64 file payload');
  }
  if (!buf || buf.length === 0) throw new ApiError(400, 'Uploaded file is empty');
  if (buf.length > MAX_FILE_BYTES) {
    throw new ApiError(400, `File too large. Max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`);
  }
  return buf;
};

const readWorkbook = (buffer) => {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellNF: false, cellText: true });
  } catch (e) {
    throw new ApiError(400, 'Could not read the Excel file. Make sure it is a valid .xlsx');
  }
  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    throw new ApiError(400, 'The workbook has no sheets');
  }
  return wb;
};

/** Reads the first non-empty row as headers; returns { headers[], rows[] } where rows is array of plain objects keyed by header. */
const readSheetAsRecords = (wb, sheetName) => {
  const name = sheetName && wb.Sheets[sheetName] ? sheetName : wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws) throw new ApiError(400, `Sheet "${name}" not found`);

  // raw:false coerces numbers/dates to display strings — safer for phone numbers.
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false, blankrows: false });
  if (!grid.length) return { sheet: name, headers: [], rows: [] };

  // Some files have a title row; pick the first row that has at least 2 non-empty cells as headers.
  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(grid.length, 5); i += 1) {
    const cells = grid[i] || [];
    const non = cells.filter((c) => c != null && String(c).trim() !== '').length;
    if (non >= 2) {
      headerRowIdx = i;
      break;
    }
  }
  const headerRow = (grid[headerRowIdx] || []).map((c) => (c == null ? '' : String(c).trim()));
  // Disambiguate empty / duplicate headers so each column has a unique key.
  // First occurrence keeps the original label (so client-side mapping still resolves);
  // subsequent collisions get a numeric suffix.
  const seenHeader = new Map();
  const headers = headerRow.map((h, i) => {
    const base = h || `Column ${i + 1}`;
    const count = seenHeader.get(base) || 0;
    seenHeader.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });

  const rows = [];
  for (let r = headerRowIdx + 1; r < grid.length; r += 1) {
    const arr = grid[r] || [];
    const obj = {};
    let hasAny = false;
    for (let c = 0; c < headers.length; c += 1) {
      const v = arr[c];
      obj[headers[c]] = v == null ? '' : String(v);
      if (v != null && String(v).trim() !== '') hasAny = true;
    }
    obj.__rowNumber = r + 1; // 1-based to match Excel
    if (hasAny) rows.push(obj);
  }

  return { sheet: name, headers, rows };
};

/* ----------------------------- Public service API ----------------------------- */

const previewWorkbook = async (fileBase64, sheetName) => {
  const buffer = decodeFile(fileBase64);
  const wb = readWorkbook(buffer);
  const { sheet, headers, rows } = readSheetAsRecords(wb, sheetName);

  if (rows.length > MAX_ROWS) {
    throw new ApiError(
      400,
      `This file has ${rows.length} rows. Max ${MAX_ROWS} per import — please split the file and try again.`
    );
  }

  const mapping = inferMapping(headers);
  const sample = rows.slice(0, PREVIEW_ROWS).map((r) => {
    const { payload } = buildDoctorPayload(r, mapping);
    return { row: r.__rowNumber, ...payload };
  });

  return {
    sheets: wb.SheetNames,
    sheet,
    headers,
    totalRows: rows.length,
    mapping,
    sampleRows: sample,
    fields: FIELDS,
    fieldLabels: FIELD_LABELS,
    requiredFields: REQUIRED_FIELDS,
    limits: { maxRows: MAX_ROWS, maxFileBytes: MAX_FILE_BYTES }
  };
};

/**
 * Validates one row against `createDoctorSchema` (the same schema POST /doctors uses).
 * Returns { ok, value, error }
 */
const validateRow = (payload) => {
  // Drop empty optional strings so Joi allow('') doesn't matter and createDoctorSchema is happy.
  const cleaned = { ...payload };
  Object.keys(cleaned).forEach((k) => {
    if (cleaned[k] === '' || cleaned[k] === undefined) delete cleaned[k];
    if (k === 'patientCount' && cleaned[k] === null) delete cleaned[k];
  });
  const { error, value } = createDoctorSchema.validate(cleaned, { abortEarly: false, stripUnknown: true });
  if (error) {
    const first = error.details[0];
    return {
      ok: false,
      error: {
        field: (first.path && first.path[0]) || null,
        code: first.type || 'INVALID',
        message: first.message
      }
    };
  }
  return { ok: true, value };
};

const commitWorkbook = async (companyId, reqUser, fileBase64, mappingFromClient, options = {}) => {
  const buffer = decodeFile(fileBase64);
  const wb = readWorkbook(buffer);
  const { sheet, headers, rows } = readSheetAsRecords(wb, options.sheet);

  if (rows.length > MAX_ROWS) {
    throw new ApiError(
      400,
      `This file has ${rows.length} rows. Max ${MAX_ROWS} per import — please split the file and try again.`
    );
  }

  // Trust the server-built mapping shape; only accept canonical keys.
  const mapping = {};
  for (const f of FIELDS) {
    const h = mappingFromClient ? mappingFromClient[f] : null;
    mapping[f] = h && headers.includes(h) ? h : null;
  }
  if (!mapping.name) {
    throw new ApiError(400, 'Doctor Name column must be mapped before import');
  }

  const skipDuplicates = options.skipDuplicates !== false;

  // Pass 1: build payloads, dedupe in-file, validate.
  const prepared = []; // { rowNumber, payload, dedupe }
  const failures = [];
  let blankCount = 0;
  let inFileDupCount = 0;
  const seenCode = new Set();
  const seenNameMobile = new Set();

  for (const r of rows) {
    const { payload, blank } = buildDoctorPayload(r, mapping);
    if (blank) {
      blankCount += 1;
      continue;
    }

    const v = validateRow(payload);
    if (!v.ok) {
      failures.push({
        row: r.__rowNumber,
        status: 'FAILED_VALIDATION',
        field: v.error.field,
        code: v.error.code,
        message: v.error.message,
        source: r
      });
      continue;
    }

    const keys = dedupeKeysFor(v.value);
    let isInFileDup = false;
    if (keys.codeKey && seenCode.has(keys.codeKey)) isInFileDup = true;
    if (!isInFileDup && keys.nameMobile && seenNameMobile.has(keys.nameMobile)) isInFileDup = true;

    if (isInFileDup) {
      if (skipDuplicates) {
        inFileDupCount += 1;
        failures.push({
          row: r.__rowNumber,
          status: 'SKIPPED_DUPLICATE_IN_FILE',
          field: keys.codeKey ? 'doctorCode' : 'name',
          code: 'DUPLICATE',
          message: 'Duplicate row inside the same file',
          source: r
        });
        continue;
      }
    }

    if (keys.codeKey) seenCode.add(keys.codeKey);
    if (keys.nameMobile) seenNameMobile.add(keys.nameMobile);

    prepared.push({ rowNumber: r.__rowNumber, payload: v.value, dedupe: keys, source: r });
  }

  // Pass 2: chunked DB dedupe + insert.
  let created = 0;
  let skipped = inFileDupCount;
  const insertedIds = [];

  for (let i = 0; i < prepared.length; i += CHUNK_SIZE) {
    const chunk = prepared.slice(i, i + CHUNK_SIZE);

    let dbDups = new Map(); // dedupe key string -> existing _id (string)
    if (skipDuplicates) {
      const codes = chunk
        .map((p) => p.payload.doctorCode)
        .filter((c) => c && c.trim() !== '');
      const nameMobiles = chunk
        .filter((p) => p.payload.name && p.payload.mobileNo)
        .map((p) => ({ name: p.payload.name, mobileNo: p.payload.mobileNo }));

      const orQ = [];
      if (codes.length) orQ.push({ doctorCode: { $in: codes } });
      // Mongo doesn't easily express composite case-insensitive matches in $in; build per-row $or guard.
      for (const nm of nameMobiles) {
        orQ.push({
          name: nm.name,
          mobileNo: nm.mobileNo
        });
      }

      if (orQ.length) {
        const existing = await Doctor.find({
          companyId,
          isDeleted: { $ne: true },
          $or: orQ
        })
          .select('_id name mobileNo doctorCode')
          .lean();
        for (const e of existing) {
          if (e.doctorCode) dbDups.set(`code:${String(e.doctorCode).toLowerCase()}`, String(e._id));
          if (e.name && e.mobileNo) {
            dbDups.set(`nm:${String(e.name).toLowerCase()}|${e.mobileNo}`, String(e._id));
          }
        }
      }
    }

    const insertable = [];
    for (const p of chunk) {
      const codeHit = p.dedupe.codeKey ? dbDups.get(`code:${p.dedupe.codeKey}`) : null;
      const nmHit = p.dedupe.nameMobile ? dbDups.get(`nm:${p.dedupe.nameMobile}`) : null;
      if (skipDuplicates && (codeHit || nmHit)) {
        skipped += 1;
        failures.push({
          row: p.rowNumber,
          status: 'SKIPPED_DUPLICATE',
          field: codeHit ? 'doctorCode' : 'name',
          code: 'DUPLICATE',
          message: codeHit
            ? `Doctor code "${p.payload.doctorCode}" already exists`
            : `A doctor named "${p.payload.name}" with mobile "${p.payload.mobileNo}" already exists`,
          source: p.source
        });
        continue;
      }
      insertable.push({
        ...p.payload,
        companyId,
        createdBy: reqUser.userId
      });
    }

    if (insertable.length) {
      try {
        const docs = await Doctor.insertMany(insertable, { ordered: false });
        created += docs.length;
        for (const d of docs) insertedIds.push(d._id);
      } catch (err) {
        // ordered:false -> some may have inserted; mongoose attaches insertedDocs on the error
        const okDocs = err.insertedDocs || (Array.isArray(err.results) ? err.results : []);
        if (Array.isArray(okDocs)) {
          for (const d of okDocs) {
            if (d && d._id) insertedIds.push(d._id);
          }
          created += okDocs.length;
        }
        const writeErrors = err.writeErrors || (err.result && err.result.result && err.result.result.writeErrors) || [];
        // Map errored entries back to their source row number using the chunk-prepared list order.
        for (const we of writeErrors) {
          const idx = typeof we.index === 'number' ? we.index : -1;
          const failed = idx >= 0 ? insertable[idx] : null;
          const sourceRow =
            failed
              ? chunk.find((p) => p.payload === failed || p.payload.name === failed.name && p.payload.mobileNo === failed.mobileNo)?.rowNumber
              : null;
          failures.push({
            row: sourceRow || null,
            status: 'FAILED_DB',
            field: null,
            code: we.code || 'DB_ERROR',
            message: (we.errmsg || we.message || 'Database error').slice(0, 500),
            source: failed || null
          });
        }
        if (!writeErrors.length && !okDocs.length) {
          // Unknown error shape — fail the whole chunk so the user can see it.
          for (const it of insertable) {
            failures.push({
              row: null,
              status: 'FAILED_DB',
              field: null,
              code: 'DB_ERROR',
              message: (err.message || 'Database error').slice(0, 500),
              source: it
            });
          }
        }
      }
    }
  }

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'doctor.bulkImport',
    entityType: 'Doctor',
    entityId: null,
    changes: {
      after: {
        sheet,
        totalRows: rows.length,
        created,
        skipped,
        failed: failures.filter((f) => String(f.status).startsWith('FAILED')).length,
        skippedDuplicates: skipped,
        blankRows: blankCount
      }
    }
  });

  const failed = failures.filter((f) => String(f.status).startsWith('FAILED')).length;

  return {
    sheet,
    totalRows: rows.length,
    blankRows: blankCount,
    created,
    skipped,
    failed,
    errors: failures.slice(0, ERRORS_INLINE_LIMIT),
    errorsTruncated: failures.length > ERRORS_INLINE_LIMIT,
    fullErrorCount: failures.length
  };
};

const buildTemplateBuffer = () => {
  const headers = FIELDS.map((f) => FIELD_LABELS[f]);
  const example = {
    [FIELD_LABELS.name]: 'DR EXAMPLE NAME',
    [FIELD_LABELS.doctorCode]: '494223',
    [FIELD_LABELS.specialization]: 'GENERAL PHYSICIAN',
    [FIELD_LABELS.qualification]: 'MBBS',
    [FIELD_LABELS.designation]: 'Consultant',
    [FIELD_LABELS.gender]: 'Male',
    [FIELD_LABELS.mobileNo]: '03001234567',
    [FIELD_LABELS.phone]: '',
    [FIELD_LABELS.email]: '',
    [FIELD_LABELS.zone]: 'QTA',
    [FIELD_LABELS.doctorBrick]: 'JINNAH ROAD',
    [FIELD_LABELS.frequency]: 'Weekly',
    [FIELD_LABELS.grade]: 'A+',
    [FIELD_LABELS.locationName]: 'CIVIL HOSPITAL',
    [FIELD_LABELS.address]: 'Jinnah Road',
    [FIELD_LABELS.city]: 'Quetta',
    [FIELD_LABELS.pmdcRegistration]: 'SMART',
    [FIELD_LABELS.patientCount]: 30
  };
  const ws = XLSX.utils.json_to_sheet([example], { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Doctors');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

module.exports = {
  previewWorkbook,
  commitWorkbook,
  buildTemplateBuffer,
  // Exposed for tests / future use
  _internals: { decodeFile, readWorkbook, readSheetAsRecords, validateRow }
};

// Quiet linter: mongoose import kept for future use (e.g. ObjectId casts).
void mongoose;
