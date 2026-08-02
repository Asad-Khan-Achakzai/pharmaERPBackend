const express = require('express');
const router = express.Router();
const c = require('../../controllers/tax.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermissionAny } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const {
  updateConfigSchema,
  createRuleSchema,
  updateRuleSchema,
  previewSchema,
  remittanceSchema,
  createDepositSchema,
  updateDepositSchema,
  depositEntriesSchema,
  submitDepositSchema,
  attachReceiptSchema,
  cancelDepositSchema,
  reverseDepositSchema
} = require('../../validators/tax.validator');

router.use(authenticate, companyScope);

const taxView = checkPermissionAny('tax.view', 'tax.manage', 'admin.access');
const taxManage = checkPermissionAny('tax.manage', 'tax.config.manage', 'admin.access');
const taxReports = checkPermissionAny('tax.view', 'reports.tax', 'reports.view', 'admin.access');
const taxExport = checkPermissionAny(
  'tax.reports.export',
  'tax.view',
  'reports.tax',
  'tax.manage',
  'admin.access'
);
const depositManage = checkPermissionAny(
  'tax.deposits.manage',
  'tax.manage',
  'admin.access'
);
const depositSubmit = checkPermissionAny(
  'tax.deposits.submit',
  'tax.manage',
  'admin.access'
);

router.get('/catalog', taxView, c.listCatalog);
router.get('/config', taxView, c.getConfig);
router.put('/config', taxManage, validate(updateConfigSchema), c.updateConfig);

router.get('/rules', taxView, c.listRules);
router.post('/rules', taxManage, validate(createRuleSchema), c.createRule);
router.patch('/rules/:ruleId', taxManage, validate(updateRuleSchema), c.updateRule);
router.delete('/rules/:ruleId', taxManage, c.deleteRule);

router.post(
  '/preview',
  checkPermissionAny('tax.view', 'tax.manage', 'orders.deliver', 'admin.access'),
  validate(previewSchema),
  c.preview
);

router.post('/seed/pakistan-advance-tax', taxManage, c.seedPakistanPack);

router.get('/reports/register', taxReports, c.registerReport);
router.get('/reports/register/summary', taxReports, c.registerSummary);
router.get('/reports/summary', taxReports, c.summaryReport);
router.get(
  '/reports/liability',
  checkPermissionAny('tax.view', 'reports.tax', 'reports.accounting', 'admin.access'),
  c.liabilityReport
);
router.get('/reports/collection', taxReports, c.collectionSummaryReport);
router.get('/reports/by-pharmacy', taxReports, c.byPharmacyReport);
router.get('/reports/by-type', taxReports, c.byTaxTypeReport);
router.get('/reports/outstanding', taxReports, c.outstandingReport);
router.get('/reports/filing', taxReports, c.filingReport);
router.get('/reports/deposits', taxReports, c.depositHistoryReport);
router.get('/reports/reconciliation', taxReports, c.reconciliationReport);
router.get('/reports/charts', taxReports, c.chartsReport);
router.get('/reports/register/export', taxExport, c.exportRegister);
router.get('/reports/:type/export', taxExport, c.exportReport);

router.post(
  '/remittances',
  depositSubmit,
  validate(remittanceSchema),
  c.createRemittance
);

router.get('/deposits', taxView, c.listDeposits);
router.get('/deposits/open-entries', taxView, c.listOpenRegisterEntries);
router.get('/deposits/:depositId', taxView, c.getDeposit);
router.post('/deposits', depositManage, validate(createDepositSchema), c.createDeposit);
router.patch(
  '/deposits/:depositId',
  depositManage,
  validate(updateDepositSchema),
  c.updateDeposit
);
router.post(
  '/deposits/:depositId/entries',
  depositManage,
  validate(depositEntriesSchema),
  c.addDepositEntries
);
router.delete(
  '/deposits/:depositId/entries/:entryId',
  depositManage,
  c.removeDepositEntry
);
router.post(
  '/deposits/:depositId/submit',
  depositSubmit,
  validate(submitDepositSchema),
  c.submitDeposit
);
router.post(
  '/deposits/:depositId/receipt',
  depositManage,
  validate(attachReceiptSchema),
  c.attachDepositReceipt
);
router.post('/deposits/:depositId/close', depositManage, c.closeDeposit);
router.post(
  '/deposits/:depositId/reverse',
  depositSubmit,
  validate(reverseDepositSchema),
  c.reverseDeposit
);
router.post(
  '/deposits/:depositId/cancel',
  depositManage,
  validate(cancelDepositSchema),
  c.cancelDeposit
);

module.exports = router;
