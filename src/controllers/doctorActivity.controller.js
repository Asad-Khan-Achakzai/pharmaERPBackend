const doctorActivityService = require('../services/doctorActivity.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const result = await doctorActivityService.list(req.companyId, req.query);
  ApiResponse.paginated(res, result);
});

const create = asyncHandler(async (req, res) => {
  const activity = await doctorActivityService.create(req.companyId, req.body, req.user);
  ApiResponse.created(res, activity);
});

const getById = asyncHandler(async (req, res) => {
  const activity = await doctorActivityService.getById(req.companyId, req.params.id);
  ApiResponse.success(res, activity);
});

const update = asyncHandler(async (req, res) => {
  const activity = await doctorActivityService.update(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, activity, 'Doctor activity updated');
});

const recalculate = asyncHandler(async (req, res) => {
  const activity = await doctorActivityService.recalculate(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, activity, 'Achieved sales recalculated from deliveries and returns (TP basis)');
});

const getByDoctor = asyncHandler(async (req, res) => {
  const activities = await doctorActivityService.getByDoctor(req.companyId, req.params.doctorId);
  ApiResponse.success(res, activities);
});

module.exports = { list, create, getById, update, recalculate, getByDoctor };
