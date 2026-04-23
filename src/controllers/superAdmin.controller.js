const superAdminService = require('../services/superAdmin.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const listCompanies = asyncHandler(async (req, res) => {
  const result = await superAdminService.listCompanies(req.query);
  ApiResponse.paginated(res, result, 'Companies');
});

const createCompany = asyncHandler(async (req, res) => {
  const company = await superAdminService.createCompany(req.body);
  ApiResponse.created(res, company, 'Company created');
});

const updateCompany = asyncHandler(async (req, res) => {
  const company = await superAdminService.updateCompany(req.params.id, req.body);
  ApiResponse.success(res, company, 'Company updated');
});

const getCompanySummary = asyncHandler(async (req, res) => {
  const summary = await superAdminService.getCompanySummary(req.params.id);
  ApiResponse.success(res, summary);
});

const switchCompany = asyncHandler(async (req, res) => {
  const { tokens, user, company } = await superAdminService.switchCompany(req.user.userId, req.body.companyId);
  ApiResponse.success(res, { tokens, user, company }, 'Company context updated');
});

module.exports = {
  listCompanies,
  createCompany,
  updateCompany,
  getCompanySummary,
  switchCompany
};
