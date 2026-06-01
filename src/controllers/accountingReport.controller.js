const accountingReportService = require('../services/accountingReport.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const trialBalance = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await accountingReportService.trialBalance(req.companyId, req.query, req.context.timeZone));
});

const generalLedger = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await accountingReportService.generalLedger(req.companyId, req.query, req.context.timeZone));
});

const profitAndLoss = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await accountingReportService.profitAndLoss(req.companyId, req.query, req.context.timeZone));
});

const balanceSheet = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await accountingReportService.balanceSheet(req.companyId, req.query, req.context.timeZone));
});

const dayBook = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await accountingReportService.dayBook(req.companyId, req.query, req.context.timeZone));
});

const cashBook = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await accountingReportService.cashBook(req.companyId, req.query, req.context.timeZone));
});

const bankBook = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await accountingReportService.bankBook(req.companyId, req.query, req.context.timeZone));
});

const subLedgerReconciliation = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await accountingReportService.subLedgerReconciliation(req.companyId, req.query.controlCode));
});

const fiscalPeriods = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await accountingReportService.listFiscalPeriods(req.companyId));
});

const closeFiscalPeriod = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await accountingReportService.closeFiscalPeriod(req.companyId, req.params.id, req.user),
    'Fiscal period closed'
  );
});

module.exports = {
  trialBalance,
  generalLedger,
  profitAndLoss,
  balanceSheet,
  dayBook,
  cashBook,
  bankBook,
  subLedgerReconciliation,
  fiscalPeriods,
  closeFiscalPeriod
};
