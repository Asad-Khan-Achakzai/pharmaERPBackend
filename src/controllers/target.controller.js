const targetService = require('../services/target.service');
const mrepReportService = require('../services/mrepReport.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');
const { userHasPermission } = require('../utils/effectivePermissions');

const list = asyncHandler(async (req, res) => { ApiResponse.paginated(res, await targetService.list(req.companyId, req.query, req.context.timeZone)); });
const create = asyncHandler(async (req, res) => {
  ApiResponse.created(res, await targetService.create(req.companyId, req.body, req.user, req.context.timeZone));
});
const update = asyncHandler(async (req, res) => { ApiResponse.success(res, await targetService.update(req.companyId, req.params.id, req.body, req.user), 'Target updated'); });
const remove = asyncHandler(async (req, res) => {
  await targetService.remove(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, null, 'Target deleted');
});
const getByRep = asyncHandler(async (req, res) => { ApiResponse.success(res, await targetService.getByRep(req.companyId, req.params.id)); });

const packsBreakdown = asyncHandler(async (req, res) => {
  const { medicalRepId, month } = req.query;
  if (!userHasPermission(req.user, 'targets.view') && !userHasPermission(req.user, 'admin.access')) {
    await mrepReportService.assertCanViewRep(req.companyId, req.user, medicalRepId);
  }
  ApiResponse.success(
    res,
    await targetService.packsBreakdownByProduct(req.companyId, medicalRepId, month, req.context.timeZone)
  );
});

module.exports = { list, create, update, remove, getByRep, packsBreakdown };
