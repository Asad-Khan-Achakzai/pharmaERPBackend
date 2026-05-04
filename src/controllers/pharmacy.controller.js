const pharmacyService = require('../services/pharmacy.service');
const lookupService = require('../services/lookup.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const lookup = asyncHandler(async (req, res) => {
  const data = await lookupService.pharmacies(req.companyId, req.query);
  ApiResponse.success(res, data, 'OK');
});

const list = asyncHandler(async (req, res) => {
  const result = await pharmacyService.list(req.companyId, req.query, req.context.timeZone);
  ApiResponse.paginated(res, result);
});

const create = asyncHandler(async (req, res) => {
  const pharmacy = await pharmacyService.create(req.companyId, req.body, req.user);
  ApiResponse.created(res, pharmacy);
});

const getById = asyncHandler(async (req, res) => {
  const pharmacy = await pharmacyService.getById(req.companyId, req.params.id);
  ApiResponse.success(res, pharmacy);
});

const update = asyncHandler(async (req, res) => {
  const pharmacy = await pharmacyService.update(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, pharmacy, 'Pharmacy updated');
});

const remove = asyncHandler(async (req, res) => {
  await pharmacyService.remove(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, null, 'Pharmacy deactivated');
});

module.exports = { lookup, list, create, getById, update, remove };
