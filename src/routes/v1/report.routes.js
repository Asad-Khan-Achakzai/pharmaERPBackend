const express = require('express');
const Joi = require('joi');
const router = express.Router();
const c = require('../../controllers/report.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission, checkPermissionAny } = require('../../middleware/checkPermission');
const { validate, validateQuery } = require('../../middleware/validate');
const { visitSummaryQuerySchema, visitByEmployeeQuerySchema } = require('../../validators/planItem.validator');
const { dashboardQuerySchema } = require('../../validators/reportDashboard.validator');
const mrepC = require('../../controllers/mrepReport.controller');
  const {
  mrepMonthlyOverviewQuerySchema,
  mrepDoctorCoverageQuerySchema,
  mrepTerritoryCoverageQuerySchema,
  mrepDeviationSummaryQuerySchema,
  mrepRankingsQuerySchema,
  mrepTrendsQuerySchema,
  mrepTerritoryCompareQuerySchema,
  mrepCoverageDashboardQuerySchema,
  mrepCoverageDashboardDoctorsQuerySchema,
  mrepCoverageDashboardNodesQuerySchema
} = require('../../validators/mrepReport.validator');

const cashOpeningSchema = Joi.object({
  cashOpeningBalance: Joi.number().required()
});

const flowMonthsQuerySchema = Joi.object({
  months: Joi.number().integer().min(1).max(36).default(12)
});

const monthlySummaryQuerySchema = Joi.object({
  fiscalYearStart: Joi.number().integer().min(2000).max(2100),
  fiscalYear: Joi.number().integer().min(2000).max(2100)
});

const monthlySummaryProductPacksQuerySchema = Joi.object({
  month: Joi.string().pattern(/^\d{4}-\d{2}$/).required(),
  fiscalYearStart: Joi.number().integer().min(2000).max(2100),
  fiscalYear: Joi.number().integer().min(2000).max(2100)
});

const monthlySummaryTpEventsQuerySchema = Joi.object({
  month: Joi.string().pattern(/^\d{4}-\d{2}$/).required(),
  fiscalYearStart: Joi.number().integer().min(2000).max(2100),
  fiscalYear: Joi.number().integer().min(2000).max(2100),
  bucket: Joi.string()
    .valid(
      'grossDeliveries',
      'returnsCurrentPeriod',
      'returnsPriorPeriod',
      'amendmentsCurrentPeriod',
      'amendmentsPriorPeriod',
      'netTpSales',
      'dashboardExclusion'
    )
    .default('netTpSales'),
  medicalRepId: Joi.string().hex().length(24),
  pharmacyId: Joi.string().hex().length(24),
  productId: Joi.string().hex().length(24),
  orderNumber: Joi.string().max(80),
  invoiceNumber: Joi.string().max(80),
  eventDateFrom: Joi.string().max(32),
  eventDateTo: Joi.string().max(32),
  q: Joi.string().max(120),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(50),
  sort: Joi.string().valid('eventAt', '-eventAt').default('-eventAt')
});

router.use(authenticate, companyScope);
router.get('/visit-summary', checkPermission('reports.view'), validateQuery(visitSummaryQuerySchema), c.visitSummary);
router.get('/visit-by-employee', checkPermission('reports.view'), validateQuery(visitByEmployeeQuerySchema), c.visitByEmployee);
router.get('/dashboard', checkPermission('dashboard.view'), validateQuery(dashboardQuerySchema), c.dashboard);
router.get('/sales', checkPermission('reports.view'), c.sales);
router.get('/profit', checkPermission('reports.view'), c.profit);
router.get('/expenses', checkPermission('reports.view'), c.expenses);
router.get('/inventory-valuation', checkPermission('reports.view'), c.inventoryValuation);
router.get('/doctor-roi', checkPermission('reports.view'), c.doctorROI);
router.get('/rep-performance', checkPermission('reports.view'), c.repPerformance);
router.get('/outstanding', checkPermission('reports.view'), c.outstanding);
router.get('/cash-flow', checkPermission('reports.view'), c.cashFlow);

/** Financial position & period activity (collections, settlements, clearing). */
router.get('/financial/overview', checkPermission('reports.view'), c.financialOverview);
router.get('/financial/pharmacy-balances', checkPermission('reports.view'), c.pharmacyBalances);
router.get('/financial/pharmacies/:id/workspace', checkPermission('reports.view'), c.pharmacyFinancialWorkspace);
router.get('/financial/pharmacies/:id/statement.pdf', checkPermission('ledger.view'), c.pharmacyStatementPdf);
router.get('/financial/pharmacies/:id/detail', checkPermission('reports.view'), c.pharmacyBalanceDetail);
router.get('/financial/distributor-balances', checkPermission('reports.view'), c.distributorBalances);
router.get('/financial/distributors/:id/detail', checkPermission('reports.view'), c.distributorBalanceDetail);
router.get('/financial/collections', checkPermission('reports.view'), c.collectionsPeriod);
router.get('/financial/settlements', checkPermission('reports.view'), c.settlementsPeriod);
router.get('/financial/cash-summary', checkPermission('reports.view'), c.financialCashSummary);

/** Balance-sheet style summary (cash, receivables, supplier & distributor payables) — does not alter PnL */
router.get('/financial-summary', checkPermission('reports.view'), c.financialSummary);
router.get('/financial-flow-monthly', checkPermission('reports.view'), validateQuery(flowMonthsQuerySchema), c.financialFlowMonthly);
router.get('/pharmacy-balance', checkPermission('reports.view'), c.pharmacyBalanceReport);
router.get('/distributor-balance', checkPermission('reports.view'), c.distributorBalanceReport);
router.get('/supplier-balance', checkPermission('reports.view'), c.supplierBalanceReport);
router.patch('/company-cash-opening', checkPermission('reports.view'), validate(cashOpeningSchema), c.patchCompanyCashOpening);

/** Profit & cost management (transaction-based revenue, auditable cost buckets) */
router.get('/summary', checkPermission('reports.view'), c.profitSummary);
router.get('/revenue', checkPermission('reports.view'), c.profitRevenue);
router.get('/costs', checkPermission('reports.view'), c.profitCosts);
router.get('/product-profitability', checkPermission('reports.view'), c.profitProductProfitability);
router.get('/trends', checkPermission('reports.view'), c.profitTrends);
router.get(
  '/monthly-summary',
  checkPermission('reports.view'),
  validateQuery(monthlySummaryQuerySchema),
  c.monthlySummary
);
router.get(
  '/monthly-summary/product-packs',
  checkPermission('reports.view'),
  validateQuery(monthlySummaryProductPacksQuerySchema),
  c.monthlySummaryProductPacks
);
router.get(
  '/monthly-summary/delivery-details',
  checkPermission('reports.view'),
  validateQuery(monthlySummaryProductPacksQuerySchema),
  c.monthlySummaryDeliveryDetailsExcel
);
router.get(
  '/monthly-summary/tp-events',
  checkPermission('reports.view'),
  validateQuery(monthlySummaryTpEventsQuerySchema),
  c.monthlySummaryTpEvents
);
router.get(
  '/monthly-summary/tp-events.xlsx',
  checkPermission('reports.view'),
  validateQuery(monthlySummaryTpEventsQuerySchema),
  c.monthlySummaryTpEventsExcel
);

/** MRep field KPIs & coverage (Phase 3 — self, team subtree, or explicit rep when allowed). */
router.get(
  '/mrep/monthly-overview',
  checkPermissionAny('weeklyPlans.view', 'weeklyPlans.markVisit', 'team.viewAllReports', 'admin.access'),
  validateQuery(mrepMonthlyOverviewQuerySchema),
  mrepC.monthlyOverview
);
router.get(
  '/mrep/doctor-coverage',
  checkPermissionAny('weeklyPlans.view', 'weeklyPlans.markVisit', 'team.viewAllReports', 'admin.access'),
  validateQuery(mrepDoctorCoverageQuerySchema),
  mrepC.doctorCoverage
);
router.get(
  '/mrep/territory-coverage',
  checkPermissionAny('territories.view', 'team.viewAllReports', 'admin.access'),
  validateQuery(mrepTerritoryCoverageQuerySchema),
  mrepC.territoryCoverage
);
router.get(
  '/mrep/deviation-summary',
  checkPermissionAny('weeklyPlans.view', 'weeklyPlans.markVisit', 'team.viewAllReports', 'admin.access'),
  validateQuery(mrepDeviationSummaryQuerySchema),
  mrepC.deviationSummary
);
router.get(
  '/mrep/rankings',
  checkPermissionAny('weeklyPlans.view', 'weeklyPlans.markVisit', 'team.viewAllReports', 'admin.access'),
  validateQuery(mrepRankingsQuerySchema),
  mrepC.rankings
);
router.get(
  '/mrep/trends',
  checkPermissionAny('weeklyPlans.view', 'weeklyPlans.markVisit', 'team.viewAllReports', 'admin.access'),
  validateQuery(mrepTrendsQuerySchema),
  mrepC.trends
);
router.get(
  '/mrep/territory-compare',
  checkPermissionAny('territories.view', 'team.viewAllReports', 'admin.access'),
  validateQuery(mrepTerritoryCompareQuerySchema),
  mrepC.territoryCompare
);

/** Date-range territory coverage dashboard (brick cards) — distinct from monthly /mrep/territory-coverage. */
router.get(
  '/mrep/coverage-dashboard',
  checkPermissionAny('weeklyPlans.view', 'weeklyPlans.markVisit', 'team.viewAllReports', 'admin.access'),
  validateQuery(mrepCoverageDashboardQuerySchema),
  mrepC.coverageDashboard
);
/** Hierarchical lazy nodes — must be registered before /:brickId. */
router.get(
  '/mrep/coverage-dashboard/nodes',
  checkPermissionAny('weeklyPlans.view', 'weeklyPlans.markVisit', 'team.viewAllReports', 'admin.access'),
  validateQuery(mrepCoverageDashboardNodesQuerySchema),
  mrepC.coverageDashboardNodes
);
router.get(
  '/mrep/coverage-dashboard/:brickId',
  checkPermissionAny('weeklyPlans.view', 'weeklyPlans.markVisit', 'team.viewAllReports', 'admin.access'),
  validateQuery(mrepCoverageDashboardDoctorsQuerySchema),
  mrepC.coverageDashboardBrickDoctors
);

module.exports = router;
