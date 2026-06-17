const express = require('express');
const router = express.Router();
const c = require('../../controllers/voucher.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createVoucherSchema, fundTransferSchema } = require('../../validators/voucher.validator');

router.use(authenticate, companyScope);
router.get('/', checkPermission('vouchers.view'), c.list);
router.post('/', checkPermission('vouchers.create'), validate(createVoucherSchema), c.create);
router.post('/fund-transfer', checkPermission('vouchers.transfer'), validate(fundTransferSchema), c.fundTransfer);
router.get('/:id', checkPermission('vouchers.view'), c.getById);
router.post('/:id/reverse', checkPermission('vouchers.reverse'), c.reverse);

module.exports = router;
