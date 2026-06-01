const express = require('express');
const router = express.Router();
const c = require('../../controllers/accountingReport.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');

router.use(authenticate, companyScope);
router.get('/trial-balance', checkPermission('reports.accounting'), c.trialBalance);
router.get('/general-ledger', checkPermission('reports.accounting'), c.generalLedger);
router.get('/profit-loss', checkPermission('reports.accounting'), c.profitAndLoss);
router.get('/balance-sheet', checkPermission('reports.accounting'), c.balanceSheet);
router.get('/day-book', checkPermission('reports.accounting'), c.dayBook);
router.get('/cash-book', checkPermission('reports.accounting'), c.cashBook);
router.get('/bank-book', checkPermission('reports.accounting'), c.bankBook);
router.get('/sub-ledger-reconciliation', checkPermission('reports.accounting'), c.subLedgerReconciliation);
router.get('/fiscal-periods', checkPermission('reports.accounting'), c.fiscalPeriods);
router.post('/fiscal-periods/:id/close', checkPermission('accounts.manage'), c.closeFiscalPeriod);

module.exports = router;
