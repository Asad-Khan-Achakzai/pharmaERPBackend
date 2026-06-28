const accountService = require('../services/account.service');
const simpleAccountService = require('../services/simpleAccount.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await accountService.list(req.companyId, req.query));
});

const tree = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await accountService.getTree(req.companyId));
});

const getById = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await accountService.getById(req.companyId, req.params.id));
});

const create = asyncHandler(async (req, res) => {
  ApiResponse.created(res, await accountService.create(req.companyId, req.body, req.user));
});

const update = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await accountService.update(req.companyId, req.params.id, req.body, req.user), 'Account updated');
});

const setOpeningBalance = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await accountService.setOpeningBalance(req.companyId, req.params.id, req.body.openingBalance, req.user),
    'Opening balance updated'
  );
});

const remove = asyncHandler(async (req, res) => {
  await accountService.remove(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, null, 'Account deleted');
});

const groupTypes = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, accountService.GROUP_TYPES);
});

const listMoneyAccounts = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await accountService.listMoneyAccounts(req.companyId, req.query));
});

const createSimple = asyncHandler(async (req, res) => {
  ApiResponse.created(res, await simpleAccountService.createSimple(req.companyId, req.body, req.user));
});

const businessView = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await simpleAccountService.getBusinessView(req.companyId));
});

const simpleTypes = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, simpleAccountService.listSimpleTypes());
});

module.exports = {
  list,
  tree,
  getById,
  create,
  update,
  setOpeningBalance,
  remove,
  groupTypes,
  listMoneyAccounts,
  createSimple,
  businessView,
  simpleTypes
};
