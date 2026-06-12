const salaryStructureService = require('../services/salaryStructure.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  ApiResponse.paginated(res, await salaryStructureService.list(req.companyId, req.query, req.context.timeZone));
});

const getById = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await salaryStructureService.getById(req.companyId, req.params.id));
});

const getActive = asyncHandler(async (req, res) => {
  const doc = await salaryStructureService.getStructureForEmployee(req.companyId, req.params.employeeId);
  ApiResponse.success(res, doc);
});

const listAssignedEmployees = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await salaryStructureService.listAssignedEmployees(req.companyId, req.params.id)
  );
});

const assignEmployees = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await salaryStructureService.assignEmployees(req.companyId, req.params.id, req.body.employeeIds, req.user),
    'Employees assigned'
  );
});

const unassignEmployees = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await salaryStructureService.unassignEmployees(req.companyId, req.params.id, req.body.employeeIds, req.user),
    'Employees unassigned'
  );
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

module.exports = {
  list,
  getById,
  getActive,
  listAssignedEmployees,
  assignEmployees,
  unassignEmployees,
  create,
  update
};
