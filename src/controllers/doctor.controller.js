const doctorService = require('../services/doctor.service');
const lookupService = require('../services/lookup.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const lookup = asyncHandler(async (req, res) => {
  const data = await lookupService.doctors(req.companyId, req.query);
  ApiResponse.success(res, data, 'OK');
});

const list = asyncHandler(async (req, res) => {
  const result = await doctorService.list(req.companyId, req.query, req.context.timeZone);
  ApiResponse.paginated(res, result);
});

const create = asyncHandler(async (req, res) => {
  const doctor = await doctorService.create(req.companyId, req.body, req.user);
  ApiResponse.created(res, doctor);
});

const getById = asyncHandler(async (req, res) => {
  const doctor = await doctorService.getById(req.companyId, req.params.id);
  ApiResponse.success(res, doctor);
});

const update = asyncHandler(async (req, res) => {
  const doctor = await doctorService.update(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, doctor, 'Doctor updated');
});

const remove = asyncHandler(async (req, res) => {
  await doctorService.remove(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, null, 'Doctor deactivated');
});

module.exports = { lookup, list, create, getById, update, remove };
