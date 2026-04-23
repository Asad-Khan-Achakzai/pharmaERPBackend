const express = require('express');
const router = express.Router();
const c = require('../../controllers/inventory.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { transferSchema } = require('../../validators/inventory.validator');

router.use(authenticate, companyScope);
router.get('/', checkPermission('inventory.view'), c.getAll);
router.get('/summary', checkPermission('inventory.view'), c.getSummary);
router.get('/transfers', checkPermission('inventory.view'), c.getTransfers);
router.get('/distributor/:id', checkPermission('inventory.view'), c.getByDistributor);
router.post('/transfer', checkPermission('inventory.transfer'), validate(transferSchema), c.transfer);

module.exports = router;
