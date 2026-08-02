const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');

const escapeCsv = (v) => {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

const rowsToCsv = (columns, rows) => {
  const header = columns.map((c) => escapeCsv(c.header)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => escapeCsv(typeof c.value === 'function' ? c.value(row) : row[c.key])).join(',')
  );
  return [header, ...lines].join('\n');
};

const rowsToExcelBuffer = (sheetName, columns, rows) => {
  const data = rows.map((row) => {
    const obj = {};
    for (const c of columns) {
      obj[c.header] = typeof c.value === 'function' ? c.value(row) : row[c.key];
    }
    return obj;
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data.length ? data : [{}]);
  XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Sheet1').slice(0, 31));
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
};

const rowsToPdfBuffer = (title, columns, rows) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(14).text(title || 'Tax Report', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(8);

    const headers = columns.map((c) => c.header).join(' | ');
    doc.text(headers);
    doc.moveDown(0.3);

    for (const row of rows.slice(0, 500)) {
      const line = columns
        .map((c) => {
          const v = typeof c.value === 'function' ? c.value(row) : row[c.key];
          return v == null ? '' : String(v);
        })
        .join(' | ');
      doc.text(line);
    }
    if (rows.length > 500) {
      doc.moveDown().text(`… and ${rows.length - 500} more rows (export Excel/CSV for full data)`);
    }
    doc.end();
  });

const sendExport = async (res, { format, filenameBase, title, columns, rows }) => {
  const fmt = String(format || 'xlsx').toLowerCase();
  const base = filenameBase || 'tax-export';

  const sendBinary = (buffer, contentType, filename) => {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Cache-Control', 'no-store');
    return res.end(buf);
  };

  if (fmt === 'xlsx' || fmt === 'excel') {
    const buffer = rowsToExcelBuffer(title || 'Export', columns, rows);
    return sendBinary(
      buffer,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `${base}.xlsx`
    );
  }
  if (fmt === 'pdf') {
    const buffer = await rowsToPdfBuffer(title || 'Tax Report', columns, rows);
    return sendBinary(buffer, 'application/pdf', `${base}.pdf`);
  }
  const csv = rowsToCsv(columns, rows);
  return sendBinary(Buffer.from(csv, 'utf8'), 'text/csv; charset=utf-8', `${base}.csv`);
};

module.exports = { rowsToCsv, rowsToExcelBuffer, rowsToPdfBuffer, sendExport };
