const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const importService = require('../services/doctorImport.service');

const preview = asyncHandler(async (req, res) => {
  const data = await importService.previewWorkbook(req.body.fileBase64, req.body.sheet);
  return ApiResponse.success(res, data, 'Preview generated');
});

const commit = asyncHandler(async (req, res) => {
  const result = await importService.commitWorkbook(
    req.context.companyId,
    req.user,
    req.body.fileBase64,
    req.body.mapping,
    { sheet: req.body.sheet, skipDuplicates: req.body.skipDuplicates }
  );
  return ApiResponse.success(res, result, 'Import finished');
});

const template = asyncHandler(async (_req, res) => {
  const buffer = importService.buildTemplateBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="doctor-import-template.xlsx"');
  res.setHeader('Content-Length', String(buffer.length));
  return res.status(200).send(buffer);
});

module.exports = { preview, commit, template };
