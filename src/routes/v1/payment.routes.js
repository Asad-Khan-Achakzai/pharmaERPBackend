const express = require('express');
const router = express.Router();
const c = require('../../controllers/payment.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createPaymentSchema } = require('../../validators/payment.validator');

router.use(authenticate, companyScope);
router.get('/', checkPermission('payments.view'), c.list);
router.post('/', checkPermission('payments.create'), validate(createPaymentSchema), c.create);
router.get('/pharmacy/:id', checkPermission('payments.view'), c.getByPharmacy);
router.get('/:id', checkPermission('payments.view'), c.getById);

module.exports = router;
