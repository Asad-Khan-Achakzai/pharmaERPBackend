const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const { resolveOrderVisibleMedicalRepIds } = require('../utils/orderScope.util');
const managerFieldDayService = require('../services/managerFieldDay.service');

const scope = async (req) => resolveOrderVisibleMedicalRepIds(req.companyId, req.user);

const list = asyncHandler(async (req, res) => {
  const visibleRepIds = await scope(req);
  const docs = await managerFieldDayService.list(
    req.companyId,
    req.query,
    req.user,
    req.context.timeZone,
    { visibleRepIds }
  );
  return ApiResponse.success(res, docs);
});

const getMe = asyncHandler(async (req, res) => {
  const visibleRepIds = await scope(req);
  const doc = await managerFieldDayService.getMeForDate(
    req.companyId,
    req.query.date,
    req.user,
    req.context.timeZone,
    { visibleRepIds }
  );
  return ApiResponse.success(res, doc);
});

const upsertMe = asyncHandler(async (req, res) => {
  const visibleRepIds = await scope(req);
  const doc = await managerFieldDayService.upsertForManager(
    req.companyId,
    req.body,
    req.user,
    req.context.timeZone,
    { visibleRepIds }
  );
  return ApiResponse.success(res, doc, doc ? 'Field day saved' : 'Field day cleared');
});

const getById = asyncHandler(async (req, res) => {
  const visibleRepIds = await scope(req);
  const doc = await managerFieldDayService.getById(req.companyId, req.params.id, {
    visibleRepIds,
    timeZone: req.context.timeZone
  });
  return ApiResponse.success(res, doc);
});

const updateById = asyncHandler(async (req, res) => {
  const visibleRepIds = await scope(req);
  const doc = await managerFieldDayService.updateById(
    req.companyId,
    req.params.id,
    req.body,
    req.user,
    req.context.timeZone,
    { visibleRepIds }
  );
  return ApiResponse.success(res, doc, doc ? 'Field day updated' : 'Field day cleared');
});

const removeById = asyncHandler(async (req, res) => {
  const visibleRepIds = await scope(req);
  const data = await managerFieldDayService.removeById(
    req.companyId,
    req.params.id,
    req.user,
    req.context.timeZone,
    { visibleRepIds }
  );
  return ApiResponse.success(res, data, 'Field day deleted');
});

const partnerListings = asyncHandler(async (req, res) => {
  const visibleRepIds = await scope(req);
  const data = await managerFieldDayService.partnerListingsForManager(
    req.companyId,
    req.user.userId,
    req.query.from,
    req.query.to,
    req.context.timeZone,
    { visibleRepIds }
  );
  return ApiResponse.success(res, data);
});

module.exports = { list, getMe, upsertMe, getById, updateById, removeById, partnerListings };
