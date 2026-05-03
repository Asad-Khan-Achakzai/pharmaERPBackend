const express = require('express');
const router = express.Router();
const c = require('../../controllers/payroll.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createPayrollSchema, updatePayrollSchema, previewPayrollSchema } = require('../../validators/payroll.validator');

router.use(authenticate, companyScope);
router.get('/', checkPermission('payroll.view'), c.list);
router.post('/preview', checkPermission('payroll.create'), validate(previewPayrollSchema), c.preview);
router.post('/', checkPermission('payroll.create'), validate(createPayrollSchema), c.create);
router.get('/:id/payslip', checkPermission('payroll.view'), c.payslip);
router.put('/:id', checkPermission('payroll.edit'), validate(updatePayrollSchema), c.update);
router.delete('/:id', checkPermission('payroll.edit'), c.remove);
router.post('/:id/pay', checkPermission('payroll.pay'), c.pay);

module.exports = router;
