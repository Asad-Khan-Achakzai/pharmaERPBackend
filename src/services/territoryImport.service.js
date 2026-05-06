/**
 * Bulk territory tree import — one row = Zone + Area + Brick (Phase 4).
 * Idempotent: re-import skips existing bricks (name under area, or code match).
 */
const XLSX = require('xlsx');
const mongoose = require('mongoose');
const Territory = require('../models/Territory');
const ApiError = require('../utils/ApiError');
const { escapeRegex } = require('../utils/listQuery');
const { TERRITORY_KIND } = require('../constants/enums');
const territoryService = require('./territory.service');
const { FIELDS, FIELD_LABELS, REQUIRED_FIELDS, inferMapping, buildRowPayload } = require('../utils/territoryImport.utils');

const MAX_ROWS = 3000;
const PREVIEW_ROWS = 10;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ERRORS_INLINE_LIMIT = 200;

const decodeFile = (fileBase64) => {
  if (!fileBase64 || typeof fileBase64 !== 'string') {
    throw new ApiError(400, 'fileBase64 is required');
  }
  const stripped = fileBase64.includes(',') ? fileBase64.split(',').pop() : fileBase64;
  let buf;
  try {
    buf = Buffer.from(stripped, 'base64');
  } catch (_e) {
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
  } catch (_e) {
    throw new ApiError(400, 'Could not read the Excel file. Make sure it is a valid .xlsx');
  }
  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    throw new ApiError(400, 'The workbook has no sheets');
  }
  return wb;
};

const readSheetAsRecords = (wb, sheetName) => {
  const name = sheetName && wb.Sheets[sheetName] ? sheetName : wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws) throw new ApiError(400, `Sheet "${name}" not found`);

  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false, blankrows: false });
  if (!grid.length) return { sheet: name, headers: [], rows: [] };

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
    obj.__rowNumber = r + 1;
    if (hasAny) rows.push(obj);
  }

  return { sheet: name, headers, rows };
};

const norm = (s) => String(s || '').trim();

const findByName = async (companyId, kind, parentId, name) => {
  const n = norm(name);
  if (!n) return null;
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const filter = {
    companyId: cid,
    kind,
    isDeleted: { $ne: true },
    name: new RegExp(`^${escapeRegex(n)}$`, 'i')
  };
  if (parentId) filter.parentId = new mongoose.Types.ObjectId(String(parentId));
  else filter.parentId = null;
  return Territory.findOne(filter).lean();
};

const previewWorkbook = async (fileBase64, sheetName) => {
  const buffer = decodeFile(fileBase64);
  const wb = readWorkbook(buffer);
  const { sheet, headers, rows } = readSheetAsRecords(wb, sheetName);

  if (rows.length > MAX_ROWS) {
    throw new ApiError(400, `This file has ${rows.length} rows. Max ${MAX_ROWS} per import.`);
  }

  const mapping = inferMapping(headers);
  const sample = rows.slice(0, PREVIEW_ROWS).map((r) => {
    const p = buildRowPayload(r, mapping);
    return { row: r.__rowNumber, ...p };
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

const commitWorkbook = async (companyId, reqUser, fileBase64, mappingFromClient, options = {}) => {
  const buffer = decodeFile(fileBase64);
  const wb = readWorkbook(buffer);
  const { sheet, headers, rows } = readSheetAsRecords(wb, options.sheet);

  if (rows.length > MAX_ROWS) {
    throw new ApiError(400, `This file has ${rows.length} rows. Max ${MAX_ROWS} per import.`);
  }

  const mapping = {};
  for (const f of FIELDS) {
    const h = mappingFromClient ? mappingFromClient[f] : null;
    mapping[f] = h && headers.includes(h) ? h : null;
  }
  if (!mapping.zone || !mapping.area || !mapping.brick) {
    throw new ApiError(400, 'Zone, Area, and Brick columns must be mapped before import');
  }

  const skipExisting = options.skipExisting !== false;

  let blankRows = 0;
  let zonesCreated = 0;
  let areasCreated = 0;
  let bricksCreated = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (const r of rows) {
    const payload = buildRowPayload(r, mapping);
    const { zone: zn, area: an, brick: bn, brick_code: bcodeRaw, is_active: isActive } = payload;
    if (!zn || !an || !bn) {
      blankRows += 1;
      continue;
    }

    const brickCode = bcodeRaw && norm(bcodeRaw) ? norm(bcodeRaw).slice(0, 64) : null;

    try {
      let zoneDoc = await findByName(companyId, TERRITORY_KIND.ZONE, null, zn);
      if (!zoneDoc) {
        zoneDoc = await territoryService.create(
          companyId,
          { name: zn, kind: TERRITORY_KIND.ZONE, parentId: null, isActive: true },
          reqUser
        );
        zonesCreated += 1;
      }

      let areaDoc = await findByName(companyId, TERRITORY_KIND.AREA, zoneDoc._id, an);
      if (!areaDoc) {
        areaDoc = await territoryService.create(
          companyId,
          { name: an, kind: TERRITORY_KIND.AREA, parentId: zoneDoc._id, isActive: true },
          reqUser
        );
        areasCreated += 1;
      }

      if (brickCode) {
        const byCode = await Territory.findOne({
          companyId,
          kind: TERRITORY_KIND.BRICK,
          code: brickCode,
          isDeleted: { $ne: true }
        }).lean();
        if (byCode) {
          if (String(byCode.parentId) !== String(areaDoc._id)) {
            failed += 1;
            errors.push({
              row: r.__rowNumber,
              status: 'FAILED_CODE_CONFLICT',
              message: `Brick code ${brickCode} already exists under a different area`
            });
            continue;
          }
          skipped += 1;
          continue;
        }
      }

      const byName = await findByName(companyId, TERRITORY_KIND.BRICK, areaDoc._id, bn);
      if (byName) {
        if (skipExisting) {
          skipped += 1;
          continue;
        }
        failed += 1;
        errors.push({
          row: r.__rowNumber,
          status: 'FAILED_DUPLICATE',
          message: `Brick "${bn}" already exists under this area`
        });
        continue;
      }

      await territoryService.create(
        companyId,
        {
          name: bn,
          kind: TERRITORY_KIND.BRICK,
          parentId: areaDoc._id,
          code: brickCode,
          isActive: isActive !== false
        },
        reqUser
      );
      bricksCreated += 1;
    } catch (e) {
      failed += 1;
      const msg = e && e.message ? e.message : String(e);
      if (errors.length < ERRORS_INLINE_LIMIT) {
        errors.push({ row: r.__rowNumber, status: 'FAILED', message: msg });
      }
    }
  }

  return {
    sheet,
    totalRows: rows.length,
    blankRows,
    zonesCreated,
    areasCreated,
    bricksCreated,
    skipped,
    failed,
    errors,
    errorsTruncated: failed > errors.length,
    fullErrorCount: failed
  };
};

const buildTemplateBuffer = () => {
  const aoa = [
    ['Zone name', 'Area name', 'Brick name', 'Brick code', 'Active'],
    ['North', 'Lahore Central', 'Gulberg', 'LHR-GLB', 'yes'],
    ['North', 'Lahore Central', 'Johar Town', 'LHR-JT', 'yes']
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Territories');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
};

module.exports = { previewWorkbook, commitWorkbook, buildTemplateBuffer };
