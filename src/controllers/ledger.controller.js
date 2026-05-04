const ledgerService = require('../services/ledger.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const result = await ledgerService.list(req.companyId, req.query, req.context.timeZone);
  ApiResponse.paginated(res, result);
});

const getByPharmacy = asyncHandler(async (req, res) => {
  const result = await ledgerService.getByPharmacy(req.companyId, req.params.id, req.query);
  ApiResponse.paginated(res, result);
});

const getBalance = asyncHandler(async (req, res) => {
  const balance = await ledgerService.getBalance(req.companyId, req.params.id);
  ApiResponse.success(res, balance);
});

const getDistributorClearingBalance = asyncHandler(async (req, res) => {
  const balance = await ledgerService.getDistributorClearingBalance(req.companyId, req.params.id);
  ApiResponse.success(res, balance);
});

module.exports = { list, getByPharmacy, getBalance, getDistributorClearingBalance };
