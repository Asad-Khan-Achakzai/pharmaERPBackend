const XLSX = require('xlsx');
const ApiError = require('../../utils/ApiError');

const decodeBase64File = (fileBase64, maxFileBytes) => {
  if (!fileBase64 || typeof fileBase64 !== 'string') {
    throw new ApiError(400, 'fileBase64 is required');
  }
  const stripped = fileBase64.includes(',') ? fileBase64.split(',').pop() : fileBase64;
  let buf;
  try {
    buf = Buffer.from(stripped, 'base64');
  } catch (err) {
    throw new ApiError(400, 'Invalid base64 file payload');
  }
  if (!buf || buf.length === 0) throw new ApiError(400, 'Uploaded file is empty');
  if (maxFileBytes && buf.length > maxFileBytes) {
    throw new ApiError(400, `File too large. Max ${Math.round(maxFileBytes / 1024 / 1024)} MB.`);
  }
  return buf;
};

const readWorkbook = (buffer) => {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellNF: false, cellText: true });
  } catch (err) {
    throw new ApiError(400, 'Could not read the Excel file. Make sure it is a valid .xlsx');
  }
  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    throw new ApiError(400, 'The workbook has no sheets');
  }
  return wb;
};

/** Returns { sheet, headers, rows } where rows are objects keyed by header and include __rowNumber. */
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

module.exports = {
  decodeBase64File,
  readWorkbook,
  readSheetAsRecords
};
