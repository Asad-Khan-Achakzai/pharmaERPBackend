const express = require('express');
const router = express.Router();
const c = require('../../controllers/payroll.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { createPayrollSchema, updatePayrollSchema, previewPayrollSchema, payPayrollSchema, pendingSummaryQuerySchema } = require('../../validators/payroll.validator');
const { validate, validateQuery } = require('../../middleware/validate');

router.use(authenticate, companyScope);
router.get('/pending-summary', checkPermission('payroll.view'), validateQuery(pendingSummaryQuerySchema), c.pendingSummary);
router.get('/', checkPermission('payroll.view'), c.list);
router.post('/preview', checkPermission('payroll.create'), validate(previewPayrollSchema), c.preview);
router.post('/', checkPermission('payroll.create'), validate(createPayrollSchema), c.create);
router.get('/:id/payslip', checkPermission('payroll.view'), c.payslip);
router.put('/:id', checkPermission('payroll.edit'), validate(updatePayrollSchema), c.update);
router.delete('/:id', checkPermission('payroll.edit'), c.remove);
router.post('/:id/pay', checkPermission('payroll.pay'), validate(payPayrollSchema), c.pay);

module.exports = router;
