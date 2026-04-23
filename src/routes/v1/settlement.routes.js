const express = require('express');
const router = express.Router();
const c = require('../../controllers/settlement.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createSettlementSchema } = require('../../validators/settlement.validator');

router.use(authenticate, companyScope);
router.get('/', checkPermission('payments.view'), c.list);
router.post('/', checkPermission('payments.create'), validate(createSettlementSchema), c.create);
router.get('/:id', checkPermission('payments.view'), c.getById);

module.exports = router;
