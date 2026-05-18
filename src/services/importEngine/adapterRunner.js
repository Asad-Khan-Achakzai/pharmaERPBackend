const ApiError = require('../../utils/ApiError');
const { decodeBase64File, readWorkbook, readSheetAsRecords } = require('./excelWorkbook');

const loadRowsFromWorkbook = ({ fileBase64, sheetName, maxFileBytes, maxRows }) => {
  const buffer = decodeBase64File(fileBase64, maxFileBytes);
  const wb = readWorkbook(buffer);
  const { sheet, headers, rows } = readSheetAsRecords(wb, sheetName);

  if (maxRows && rows.length > maxRows) {
    throw new ApiError(
      400,
      `This file has ${rows.length} rows. Max ${maxRows} per import${maxRows < 10000 ? ' — please split the file and try again.' : '.'}`
    );
  }

  return { wb, sheet, headers, rows };
};

const sanitizeMapping = ({ fields, headers, mappingFromClient }) => {
  const mapping = {};
  for (const field of fields) {
    const h = mappingFromClient ? mappingFromClient[field] : null;
    mapping[field] = h && headers.includes(h) ? h : null;
  }
  return mapping;
};

module.exports = { loadRowsFromWorkbook, sanitizeMapping };
