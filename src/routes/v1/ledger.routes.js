const express = require('express');
const router = express.Router();
const c = require('../../controllers/ledger.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');

router.use(authenticate, companyScope);
router.get('/', checkPermission('ledger.view'), c.list);
router.get('/client-statement', checkPermission('ledger.view'), c.getClientStatement);
router.get('/supplier-statement', checkPermission('ledger.view'), c.getSupplierStatement);
router.get('/expense-ledger', checkPermission('expenses.view'), c.getExpenseLedger);
router.get('/activity-ledger', checkPermission('doctors.view'), c.getActivityLedger);
router.get('/employee-statement', checkPermission('ledger.view'), c.getEmployeeStatement);
router.get('/pharmacy/:id', checkPermission('ledger.view'), c.getByPharmacy);
router.get('/pharmacy/:id/balance', checkPermission('ledger.view'), c.getBalance);
router.get('/distributor/:id/clearing-balance', checkPermission('ledger.view'), c.getDistributorClearingBalance);

module.exports = router;
