const reportService = require('../services/report.service');
const profitManagementService = require('../services/profitManagement.service');
const visitReportService = require('../services/visitReport.service');
const supplierService = require('../services/supplier.service');
const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../middleware/asyncHandler');
const { userHasPermission } = require('../utils/effectivePermissions');

const dashboard = asyncHandler(async (req, res) => {
  /** Company-wide dashboard KPIs: full admin only. `reports.view` is not enough (field roles often have it for menus). */
  const companyWideKpis = userHasPermission(req.user, 'admin.access');
  const from = req.query.from;
  const to = req.query.to;
  const opts = { timeZone: req.context.timeZone };
  if (from || to) {
    opts.from = from;
    opts.to = to;
  }
  if (!companyWideKpis) {
    opts.restrictToRepId = req.user.userId;
  }
  ApiResponse.success(res, await reportService.dashboard(req.companyId, opts));
});
const sales = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await reportService.sales(req.companyId, req.query.from, req.query.to, req.context.timeZone)
  );
});
const profit = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await reportService.profit(req.companyId, req.query.from, req.query.to, req.context.timeZone)
  );
});
const expenses = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await reportService.expenses(req.companyId, req.query.from, req.query.to, req.context.timeZone)
  );
});
const inventoryValuation = asyncHandler(async (req, res) => { ApiResponse.success(res, await reportService.inventoryValuation(req.companyId)); });
const doctorROI = asyncHandler(async (req, res) => { ApiResponse.success(res, await reportService.doctorROI(req.companyId)); });
const repPerformance = asyncHandler(async (req, res) => { ApiResponse.success(res, await reportService.repPerformance(req.companyId)); });
const outstandingReport = asyncHandler(async (req, res) => { ApiResponse.success(res, await reportService.outstanding(req.companyId)); });
const cashFlow = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await reportService.cashFlow(req.companyId, req.query.from, req.query.to, req.context.timeZone)
  );
});

const pharmacyBalances = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await reportService.pharmacyBalances(req.companyId, req.query));
});
const pharmacyBalanceDetail = asyncHandler(async (req, res) => {
  const data = await reportService.pharmacyBalanceDetail(req.companyId, req.params.id);
  if (!data) throw new ApiError(404, 'Pharmacy not found');
  ApiResponse.success(res, data);
});
const distributorBalances = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await reportService.distributorBalances(req.companyId, req.query));
});
const distributorBalanceDetail = asyncHandler(async (req, res) => {
  const data = await reportService.distributorBalanceDetail(req.companyId, req.params.id);
  if (!data) throw new ApiError(404, 'Distributor not found');
  ApiResponse.success(res, data);
});
const collectionsPeriod = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await reportService.collectionsPeriod(
      req.companyId,
      req.query.from,
      req.query.to,
      req.query,
      req.context.timeZone
    )
  );
});
const settlementsPeriod = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await reportService.settlementsPeriod(
      req.companyId,
      req.query.from,
      req.query.to,
      req.query,
      req.context.timeZone
    )
  );
});
const financialCashSummary = asyncHandler(async (req, res) => {
  const { from, to, pharmacyId, distributorId, collectorType, direction } = req.query;
  ApiResponse.success(
    res,
    await reportService.financialCashSummary(req.companyId, from, to, {
      pharmacyId,
      distributorId,
      collectorType,
      direction
    }, req.context.timeZone)
  );
});
const financialOverview = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await reportService.financialOverview(req.companyId, req.query, req.context.timeZone));
});

/** Unified cash + receivables + payables snapshot (balance-sheet style; does not change PnL). */
const financialSummary = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await reportService.financialSummary(req.companyId));
});

const financialFlowMonthly = asyncHandler(async (req, res) => {
  const months = req.query.months ? parseInt(req.query.months, 10) : 12;
  ApiResponse.success(res, await reportService.financialFlowMonthly(req.companyId, months, req.context.timeZone));
});

/** Alias names for integrations */
const pharmacyBalanceReport = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await reportService.pharmacyBalances(req.companyId, req.query));
});
const distributorBalanceReport = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await reportService.distributorBalances(req.companyId, req.query));
});
const supplierBalanceReport = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await supplierService.supplierBalances(req.companyId));
});

const patchCompanyCashOpening = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Only administrators can update cash opening balance');
  }
  ApiResponse.success(
    res,
    await reportService.patchCompanyCashOpening(req.companyId, req.body.cashOpeningBalance, req.user),
    'Cash opening balance updated'
  );
});

const profitSummary = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await profitManagementService.summary(req.companyId, req.query, req.context.timeZone));
});
const profitRevenue = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await profitManagementService.revenue(req.companyId, req.query, req.context.timeZone));
});
const profitCosts = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await profitManagementService.costs(req.companyId, req.query, req.context.timeZone));
});
const profitProductProfitability = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await profitManagementService.productProfitability(req.companyId, {
      ...req.query,
      timeZone: req.context.timeZone
    })
  );
});
const profitTrends = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await profitManagementService.trends(req.companyId, req.query, req.context.timeZone));
});

const visitSummary = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await visitReportService.visitSummary(req.companyId, req.query));
});

const visitByEmployee = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await visitReportService.visitByEmployee(req.companyId, req.query));
});

module.exports = {
  visitSummary,
  visitByEmployee,
  dashboard,
  sales,
  profit,
  expenses,
  inventoryValuation,
  doctorROI,
  repPerformance,
  outstanding: outstandingReport,
  cashFlow,
  pharmacyBalances,
  pharmacyBalanceDetail,
  distributorBalances,
  distributorBalanceDetail,
  collectionsPeriod,
  settlementsPeriod,
  financialCashSummary,
  financialOverview,
  financialSummary,
  financialFlowMonthly,
  pharmacyBalanceReport,
  distributorBalanceReport,
  supplierBalanceReport,
  patchCompanyCashOpening,
  profitSummary,
  profitRevenue,
  profitCosts,
  profitProductProfitability,
  profitTrends
};
