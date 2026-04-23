const doctorService = require('../services/doctor.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const result = await doctorService.list(req.companyId, req.query);
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

module.exports = { list, create, getById, update, remove };
