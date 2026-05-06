const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const businessTime = require('../utils/businessTime');
const mrepReportService = require('../services/mrepReport.service');

const monthlyOverview = asyncHandler(async (req, res) => {
  const tz = req.context.timeZone;
  const q = req.query.month != null && String(req.query.month).trim() !== '' ? String(req.query.month).trim() : null;
  const month =
    q && /^\d{4}-\d{2}$/.test(q) ? q : businessTime.nowInBusinessTime(tz).toFormat('yyyy-MM');
  const data = await mrepReportService.monthlyOverview(
    req.companyId,
    req.user.userId,
    req.user.permissions,
    month,
    tz,
    { repId: req.query.repId || null }
  );
  ApiResponse.success(res, data);
});

const doctorCoverage = asyncHandler(async (req, res) => {
  const tz = req.context.timeZone;
  const month = String(req.query.month);
  const repId = String(req.query.repId);
  const data = await mrepReportService.doctorCoverageForRep(
    req.companyId,
    req.user.userId,
    req.user.permissions,
    repId,
    month,
    tz
  );
  ApiResponse.success(res, data);
});

const territoryCoverage = asyncHandler(async (req, res) => {
  const tz = req.context.timeZone;
  const month = String(req.query.month);
  const territoryId = String(req.query.territoryId);
  const data = await mrepReportService.territoryCoverage(req.companyId, territoryId, month, tz);
  ApiResponse.success(res, data);
});

module.exports = { monthlyOverview, doctorCoverage, territoryCoverage };
