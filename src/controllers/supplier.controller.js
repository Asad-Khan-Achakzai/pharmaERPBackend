const supplierService = require('../services/supplier.service');
const lookupService = require('../services/lookup.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const balancesSummary = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await supplierService.supplierBalances(req.companyId));
});

const lookup = asyncHandler(async (req, res) => {
  const data = await lookupService.suppliers(req.companyId, req.query);
  ApiResponse.success(res, data, 'OK');
});

const list = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await supplierService.list(req.companyId, req.query, req.context.timeZone));
});

const getById = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await supplierService.getById(req.companyId, req.params.id));
});

const create = asyncHandler(async (req, res) => {
  ApiResponse.created(res, await supplierService.create(req.companyId, req.body, req.user), 'Supplier created');
});

const update = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await supplierService.update(req.companyId, req.params.id, req.body, req.user), 'Supplier updated');
});

const remove = asyncHandler(async (req, res) => {
  await supplierService.remove(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, null, 'Supplier deleted');
});

const ledger = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await supplierService.listLedger(req.companyId, req.params.id, req.query));
});

const balance = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await supplierService.balanceForSupplier(req.companyId, req.params.id));
});

const recordPayment = asyncHandler(async (req, res) => {
  ApiResponse.created(
    res,
    await supplierService.recordPayment(req.companyId, req.params.id, req.body, req.user),
    'Payment recorded'
  );
});

const recordPurchase = asyncHandler(async (req, res) => {
  ApiResponse.created(
    res,
    await supplierService.recordManualPurchase(req.companyId, req.params.id, req.body, req.user),
    'Purchase recorded'
  );
});

const listPayments = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await supplierService.listPayments(req.companyId, req.params.id));
});

const recentPayments = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await supplierService.recentPayments(req.companyId, req.query));
});

const paymentInvoice = asyncHandler(async (req, res) => {
  await supplierService.streamPaymentInvoice(req.companyId, req.params.ledgerId, req.user, res);
});

const updatePayment = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await supplierService.updatePayment(req.companyId, req.params.id, req.params.ledgerId, req.body, req.user),
    'Payment updated'
  );
});

const reversePayment = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await supplierService.reversePayment(req.companyId, req.params.id, req.params.ledgerId, req.body, req.user),
    'Payment reversed'
  );
});

module.exports = {
  balancesSummary,
  list,
  lookup,
  getById,
  create,
  update,
  remove,
  ledger,
  balance,
  recordPayment,
  recordPurchase,
  listPayments,
  recentPayments,
  paymentInvoice,
  updatePayment,
  reversePayment
};
