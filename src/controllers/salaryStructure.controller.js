const salaryStructureService = require('../services/salaryStructure.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  ApiResponse.paginated(res, await salaryStructureService.list(req.companyId, req.query));
});

const getById = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await salaryStructureService.getById(req.companyId, req.params.id));
});

const getActive = asyncHandler(async (req, res) => {
  const doc = await salaryStructureService.getActiveForEmployee(req.companyId, req.params.employeeId);
  ApiResponse.success(res, doc);
});

const create = asyncHandler(async (req, res) => {
  ApiResponse.created(res, await salaryStructureService.create(req.companyId, req.body, req.user));
});

const update = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await salaryStructureService.update(req.companyId, req.params.id, req.body, req.user),
    'Salary structure updated'
  );
});

module.exports = { list, getById, getActive, create, update };
