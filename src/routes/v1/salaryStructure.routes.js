const express = require('express');
const router = express.Router();
const c = require('../../controllers/salaryStructure.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createSalaryStructureSchema, updateSalaryStructureSchema } = require('../../validators/salaryStructure.validator');

router.use(authenticate, companyScope);
router.get('/', checkPermission('payroll.view'), c.list);
router.get('/active/:employeeId', checkPermission('payroll.view'), c.getActive);
router.get('/:id', checkPermission('payroll.view'), c.getById);
router.post('/', checkPermission('payroll.create'), validate(createSalaryStructureSchema), c.create);
router.put('/:id', checkPermission('payroll.edit'), validate(updateSalaryStructureSchema), c.update);

module.exports = router;
