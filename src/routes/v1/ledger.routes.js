const express = require('express');
const router = express.Router();
const c = require('../../controllers/ledger.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');

router.use(authenticate, companyScope);
router.get('/', checkPermission('ledger.view'), c.list);
router.get('/pharmacy/:id', checkPermission('ledger.view'), c.getByPharmacy);
router.get('/pharmacy/:id/balance', checkPermission('ledger.view'), c.getBalance);
router.get('/distributor/:id/clearing-balance', checkPermission('ledger.view'), c.getDistributorClearingBalance);

module.exports = router;
