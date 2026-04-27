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

const listPlatformUsers = asyncHandler(async (req, res) => {
  const result = await superAdminService.listPlatformUsers(req.query);
  ApiResponse.paginated(res, result, 'Platform users');
});

const getPlatformUser = asyncHandler(async (req, res) => {
  const user = await superAdminService.getPlatformUserById(req.params.id);
  ApiResponse.success(res, user);
});

const createPlatformUser = asyncHandler(async (req, res) => {
  const user = await superAdminService.createPlatformUser(req.body);
  ApiResponse.created(res, user, 'Platform user created');
});

const updatePlatformUser = asyncHandler(async (req, res) => {
  const user = await superAdminService.updatePlatformUser(req.params.id, req.body);
  ApiResponse.success(res, user, 'Platform user updated');
});

const deletePlatformUser = asyncHandler(async (req, res) => {
  const result = await superAdminService.deletePlatformUser(req.params.id, req.user.userId);
  ApiResponse.success(res, result, 'Platform user removed');
});

module.exports = {
  listCompanies,
  createCompany,
  updateCompany,
  getCompanySummary,
  switchCompany,
  listPlatformUsers,
  getPlatformUser,
  createPlatformUser,
  updatePlatformUser,
  deletePlatformUser
};
