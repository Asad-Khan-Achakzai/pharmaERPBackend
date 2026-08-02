const taxConfigService = require('../services/tax/taxConfig.service');
const taxReportService = require('../services/tax/taxReport.service');
const taxPostingService = require('../services/tax/taxPosting.service');
const taxDepositService = require('../services/tax/taxDeposit.service');
const { sendExport } = require('../utils/taxExport');
const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../middleware/asyncHandler');

const getConfig = asyncHandler(async (req, res) => {
  const data = await taxConfigService.getConfig(req.companyId, req.user);
  ApiResponse.success(res, data);
});

const updateConfig = asyncHandler(async (req, res) => {
  const data = await taxConfigService.updateConfig(req.companyId, req.body, req.user);
  ApiResponse.success(res, data, 'Tax configuration updated');
});

const listCatalog = asyncHandler(async (req, res) => {
  ApiResponse.success(res, taxConfigService.listCatalog());
});

const listRules = asyncHandler(async (req, res) => {
  const data = await taxConfigService.listRules(req.companyId, req.query);
  ApiResponse.success(res, data);
});

const createRule = asyncHandler(async (req, res) => {
  const data = await taxConfigService.createRule(req.companyId, req.body, req.user);
  ApiResponse.created(res, data);
});

const updateRule = asyncHandler(async (req, res) => {
  const data = await taxConfigService.updateRule(req.companyId, req.params.ruleId, req.body, req.user);
  ApiResponse.success(res, data, 'Tax rule updated');
});

const deleteRule = asyncHandler(async (req, res) => {
  await taxConfigService.deleteRule(req.companyId, req.params.ruleId, req.user);
  ApiResponse.success(res, null, 'Tax rule deleted');
});

const preview = asyncHandler(async (req, res) => {
  const data = await taxConfigService.preview(req.companyId, req.body);
  ApiResponse.success(res, data);
});

const seedPakistanPack = asyncHandler(async (req, res) => {
  const data = await taxConfigService.seedPakistanAdvanceTaxPack(req.companyId, req.user);
  ApiResponse.success(res, data, 'Pakistan Advance Tax pack applied');
});

const registerReport = asyncHandler(async (req, res) => {
  const data = await taxReportService.taxRegister(req.companyId, req.query, req.context.timeZone);
  ApiResponse.success(res, data);
});

const registerSummary = asyncHandler(async (req, res) => {
  const data = await taxReportService.registerKpis(req.companyId, req.query, req.context.timeZone);
  ApiResponse.success(res, data);
});

const summaryReport = asyncHandler(async (req, res) => {
  const data = await taxReportService.monthlySummary(req.companyId, req.query, req.context.timeZone);
  ApiResponse.success(res, data);
});

const liabilityReport = asyncHandler(async (req, res) => {
  const data = await taxReportService.liability(req.companyId, req.query);
  ApiResponse.success(res, data);
});

const collectionSummaryReport = asyncHandler(async (req, res) => {
  const data = await taxReportService.collectionSummary(
    req.companyId,
    req.query,
    req.context.timeZone
  );
  ApiResponse.success(res, data);
});

const byPharmacyReport = asyncHandler(async (req, res) => {
  const data = await taxReportService.byPharmacy(req.companyId, req.query, req.context.timeZone);
  ApiResponse.success(res, data);
});

const byTaxTypeReport = asyncHandler(async (req, res) => {
  const data = await taxReportService.byTaxType(req.companyId, req.query, req.context.timeZone);
  ApiResponse.success(res, data);
});

const outstandingReport = asyncHandler(async (req, res) => {
  const data = await taxReportService.outstandingLiabilityDetail(req.companyId);
  ApiResponse.success(res, data);
});

const filingReport = asyncHandler(async (req, res) => {
  const data = await taxReportService.governmentFiling(
    req.companyId,
    req.query,
    req.context.timeZone
  );
  ApiResponse.success(res, data);
});

const depositHistoryReport = asyncHandler(async (req, res) => {
  const data = await taxReportService.depositHistory(req.companyId, req.query, req.context.timeZone);
  ApiResponse.success(res, data);
});

const reconciliationReport = asyncHandler(async (req, res) => {
  const data = await taxReportService.reconciliationReport(
    req.companyId,
    req.query,
    req.context.timeZone
  );
  ApiResponse.success(res, data);
});

const chartsReport = asyncHandler(async (req, res) => {
  const data = await taxReportService.chartSeries(req.companyId, req.query, req.context.timeZone);
  ApiResponse.success(res, data);
});

const exportRegister = asyncHandler(async (req, res) => {
  const data = await taxReportService.taxRegister(
    req.companyId,
    { ...req.query, limit: 2000 },
    req.context.timeZone
  );
  await sendExport(res, {
    format: req.query.format || 'xlsx',
    filenameBase: 'tax-register',
    title: 'Tax Register',
    columns: taxReportService.registerExportColumns(),
    rows: data.rows
  });
});

const exportReport = asyncHandler(async (req, res) => {
  const type = String(req.params.type || 'collection');
  const format = req.query.format || 'xlsx';
  const tz = req.context.timeZone;
  let title = 'Tax Report';
  let filenameBase = `tax-${type}`;
  let columns = [];
  let rows = [];

  if (type === 'collection') {
    const d = await taxReportService.collectionSummary(req.companyId, req.query, tz);
    title = 'Tax Collection Summary';
    columns = [
      { key: 'metric', header: 'Metric' },
      { key: 'value', header: 'Value' }
    ];
    rows = [
      { metric: 'Collected', value: d.collected },
      { metric: 'Remitted', value: d.remitted },
      { metric: 'Outstanding', value: d.outstanding },
      { metric: 'Pending Entries', value: d.pendingEntries },
      { metric: 'Invoices With Tax', value: d.invoicesWithTax },
      { metric: 'Period', value: d.currentTaxPeriod }
    ];
  } else if (type === 'monthly') {
    const d = await taxReportService.monthlySummary(req.companyId, req.query, tz);
    title = 'Monthly Tax Summary';
    columns = [
      { key: 'periodKey', header: 'Period' },
      { key: 'taxTypeLabel', header: 'Tax Type' },
      { key: 'taxableAmount', header: 'Taxable' },
      { key: 'taxAmount', header: 'Tax' },
      { key: 'entryCount', header: 'Entries' }
    ];
    rows = d.rows;
  } else if (type === 'pharmacy') {
    const d = await taxReportService.byPharmacy(req.companyId, req.query, tz);
    title = 'Tax By Pharmacy';
    columns = [
      { key: 'pharmacyName', header: 'Pharmacy' },
      { key: 'taxableAmount', header: 'Taxable' },
      { key: 'taxAmount', header: 'Tax' },
      { key: 'entryCount', header: 'Entries' }
    ];
    rows = d.rows;
  } else if (type === 'type') {
    const d = await taxReportService.byTaxType(req.companyId, req.query, tz);
    title = 'Tax By Type';
    columns = [
      { key: 'taxTypeLabel', header: 'Tax Type' },
      { key: 'taxableAmount', header: 'Taxable' },
      { key: 'taxAmount', header: 'Tax' },
      { key: 'entryCount', header: 'Entries' }
    ];
    rows = d.rows;
  } else if (type === 'outstanding') {
    const d = await taxReportService.outstandingLiabilityDetail(req.companyId);
    title = 'Outstanding Liability';
    columns = taxReportService.registerExportColumns();
    rows = d.rows;
  } else if (type === 'filing') {
    const d = await taxReportService.governmentFiling(req.companyId, req.query, tz);
    title = 'Government Filing Report';
    columns = [
      { key: 'depositNumber', header: 'Deposit' },
      { key: 'governmentAuthority', header: 'Authority' },
      { key: 'paymentDate', header: 'Payment Date', value: (r) => (r.paymentDate ? String(r.paymentDate).slice(0, 10) : '') },
      { key: 'paymentReference', header: 'Payment Ref' },
      { key: 'bankReference', header: 'Bank Ref' },
      { key: 'amount', header: 'Amount' },
      { key: 'status', header: 'Status' }
    ];
    rows = d.deposits;
  } else if (type === 'deposits') {
    const d = await taxReportService.depositHistory(req.companyId, req.query, tz);
    title = 'Deposit History';
    columns = [
      { key: 'depositNumber', header: 'Deposit Number' },
      { key: 'governmentAuthority', header: 'Authority' },
      { key: 'paymentDate', header: 'Payment Date', value: (r) => (r.paymentDate ? String(r.paymentDate).slice(0, 10) : '') },
      { key: 'amount', header: 'Amount' },
      { key: 'status', header: 'Status' },
      { key: 'paymentReference', header: 'Payment Ref' }
    ];
    rows = d.rows;
  } else if (type === 'reconciliation') {
    const d = await taxReportService.reconciliationReport(req.companyId, req.query, tz);
    title = 'Tax Reconciliation';
    columns = [
      { key: 'metric', header: 'Metric' },
      { key: 'value', header: 'Value' }
    ];
    rows = [
      { metric: 'GL Balance', value: d.glBalance },
      { metric: 'Register Balance', value: d.registerBalance },
      { metric: 'Difference', value: d.difference },
      { metric: 'Out of Balance', value: d.outOfBalance ? 'Yes' : 'No' }
    ];
  } else if (type === 'register') {
    return exportRegister(req, res);
  } else {
    throw new ApiError(400, 'Unknown export type');
  }

  await sendExport(res, { format, filenameBase, title, columns, rows });
});

const createRemittance = asyncHandler(async (req, res) => {
  const data = await taxPostingService.postRemittance(req.companyId, req.body, req.user);
  ApiResponse.created(res, data, 'Tax remittance posted');
});

const listDeposits = asyncHandler(async (req, res) => {
  const data = await taxDepositService.listDeposits(req.companyId, req.query);
  ApiResponse.success(res, data);
});

const getDeposit = asyncHandler(async (req, res) => {
  const data = await taxDepositService.getDeposit(req.companyId, req.params.depositId);
  ApiResponse.success(res, data);
});

const createDeposit = asyncHandler(async (req, res) => {
  const data = await taxDepositService.createDeposit(req.companyId, req.body, req.user);
  ApiResponse.created(res, data, 'Tax remittance created');
});

const updateDeposit = asyncHandler(async (req, res) => {
  const data = await taxDepositService.updateDeposit(
    req.companyId,
    req.params.depositId,
    req.body,
    req.user
  );
  ApiResponse.success(res, data, 'Tax remittance updated');
});

const addDepositEntries = asyncHandler(async (req, res) => {
  const data = await taxDepositService.addEntries(
    req.companyId,
    req.params.depositId,
    req.body.registerEntryIds || req.body.entryIds || [],
    req.user
  );
  ApiResponse.success(res, data, 'Entries added to deposit');
});

const removeDepositEntry = asyncHandler(async (req, res) => {
  const data = await taxDepositService.removeEntry(
    req.companyId,
    req.params.depositId,
    req.params.entryId,
    req.user
  );
  ApiResponse.success(res, data, 'Entry removed from deposit');
});

const submitDeposit = asyncHandler(async (req, res) => {
  const data = await taxDepositService.submitDeposit(
    req.companyId,
    req.params.depositId,
    req.body,
    req.user
  );
  ApiResponse.success(res, data, 'Tax remittance submitted');
});

const attachDepositReceipt = asyncHandler(async (req, res) => {
  const data = await taxDepositService.attachReceipt(
    req.companyId,
    req.params.depositId,
    req.body,
    req.user
  );
  ApiResponse.success(res, data, 'Receipt uploaded');
});

const closeDeposit = asyncHandler(async (req, res) => {
  const data = await taxDepositService.closeDeposit(req.companyId, req.params.depositId, req.user);
  ApiResponse.success(res, data, 'Tax remittance noted as closed (optional; submit already completes posting)');
});

const reverseDeposit = asyncHandler(async (req, res) => {
  const data = await taxDepositService.reverseDeposit(
    req.companyId,
    req.params.depositId,
    req.body,
    req.user
  );
  ApiResponse.success(res, data, 'Tax remittance reversed');
});

const cancelDeposit = asyncHandler(async (req, res) => {
  const data = await taxDepositService.cancelDeposit(
    req.companyId,
    req.params.depositId,
    req.body,
    req.user
  );
  ApiResponse.success(res, data, 'Tax remittance cancelled');
});

const listOpenRegisterEntries = asyncHandler(async (req, res) => {
  const data = await taxDepositService.listOpenEntries(req.companyId, req.query);
  ApiResponse.success(res, data);
});

module.exports = {
  getConfig,
  updateConfig,
  listCatalog,
  listRules,
  createRule,
  updateRule,
  deleteRule,
  preview,
  seedPakistanPack,
  registerReport,
  registerSummary,
  summaryReport,
  liabilityReport,
  collectionSummaryReport,
  byPharmacyReport,
  byTaxTypeReport,
  outstandingReport,
  filingReport,
  depositHistoryReport,
  reconciliationReport,
  chartsReport,
  exportRegister,
  exportReport,
  createRemittance,
  listDeposits,
  getDeposit,
  createDeposit,
  updateDeposit,
  addDepositEntries,
  removeDepositEntry,
  submitDeposit,
  attachDepositReceipt,
  closeDeposit,
  reverseDeposit,
  cancelDeposit,
  listOpenRegisterEntries
};
