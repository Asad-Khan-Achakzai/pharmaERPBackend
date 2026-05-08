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
    req.user,
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
    req.user,
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

const deviationSummary = asyncHandler(async (req, res) => {
  const tz = req.context.timeZone;
  const month = String(req.query.month);
  const data = await mrepReportService.deviationSummary(
    req.companyId,
    req.user,
    month,
    tz,
    { repId: req.query.repId || null }
  );
  ApiResponse.success(res, data);
});

const rankings = asyncHandler(async (req, res) => {
  const tz = req.context.timeZone;
  const month = String(req.query.month);
  const data = await mrepReportService.rankings(
    req.companyId,
    req.user,
    month,
    tz,
    { repId: req.query.repId || null }
  );
  ApiResponse.success(res, data);
});

const trends = asyncHandler(async (req, res) => {
  const tz = req.context.timeZone;
  const months = req.query.months != null ? Number(req.query.months) : 6;
  const data = await mrepReportService.trends(
    req.companyId,
    req.user,
    months,
    tz,
    { repId: req.query.repId || null }
  );
  ApiResponse.success(res, data);
});

const territoryCompare = asyncHandler(async (req, res) => {
  const tz = req.context.timeZone;
  const month = String(req.query.month);
  const parentId = String(req.query.parentTerritoryId);
  const data = await mrepReportService.territoryCompare(
    req.companyId,
    parentId,
    month,
    tz,
    req.user.userId,
    req.user.permissions
  );
  ApiResponse.success(res, data);
});

module.exports = {
  monthlyOverview,
  doctorCoverage,
  territoryCoverage,
  deviationSummary,
  rankings,
  trends,
  territoryCompare
};
