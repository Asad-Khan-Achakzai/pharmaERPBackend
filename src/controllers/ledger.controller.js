const ledgerService = require('../services/ledger.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const result = await ledgerService.list(req.companyId, req.query, req.context.timeZone);
  ApiResponse.paginated(res, result);
});

const getByPharmacy = asyncHandler(async (req, res) => {
  const result = await ledgerService.getByPharmacy(
    req.companyId,
    req.params.id,
    req.query,
    req.context.timeZone
  );
  ApiResponse.paginatedWithMeta(res, {
    docs: result.docs,
    total: result.total,
    page: result.page,
    limit: result.limit,
    meta: {
      openingBalance: result.openingBalance,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      cursorMode: result.cursorMode
    }
  });
});

const getBalance = asyncHandler(async (req, res) => {
  const balance = await ledgerService.getBalance(req.companyId, req.params.id);
  ApiResponse.success(res, balance);
});

const getDistributorClearingBalance = asyncHandler(async (req, res) => {
  const balance = await ledgerService.getDistributorClearingBalance(req.companyId, req.params.id);
  ApiResponse.success(res, balance);
});

const getClientStatement = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await ledgerService.getClientStatement(req.companyId, req.query, req.context.timeZone));
});

const getSupplierStatement = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await ledgerService.getSupplierStatement(req.companyId, req.query, req.context.timeZone));
});

const getExpenseLedger = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await ledgerService.getExpenseLedger(req.companyId, req.query, req.context.timeZone));
});

const getEmployeeStatement = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await ledgerService.getEmployeeStatement(req.companyId, req.query, req.context.timeZone));
});

const getActivityLedger = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await ledgerService.getActivityLedger(req.companyId, req.query, req.context.timeZone));
});

module.exports = {
  list,
  getByPharmacy,
  getBalance,
  getDistributorClearingBalance,
  getClientStatement,
  getSupplierStatement,
  getExpenseLedger,
  getEmployeeStatement,
  getActivityLedger
};
