const express = require('express');
const router = express.Router();
const c = require('../../controllers/salaryStructure.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const {
  createSalaryStructureSchema,
  updateSalaryStructureSchema,
  assignEmployeesSchema
} = require('../../validators/salaryStructure.validator');

router.use(authenticate, companyScope);
router.get('/', checkPermission('payroll.view'), c.list);
router.get('/active/:employeeId', checkPermission('payroll.view'), c.getActive);
router.get('/:id/employees', checkPermission('payroll.view'), c.listAssignedEmployees);
router.post(
  '/:id/assign',
  checkPermission('payroll.edit'),
  validate(assignEmployeesSchema),
  c.assignEmployees
);
router.post(
  '/:id/unassign',
  checkPermission('payroll.edit'),
  validate(assignEmployeesSchema),
  c.unassignEmployees
);
router.get('/:id', checkPermission('payroll.view'), c.getById);
router.post('/', checkPermission('payroll.create'), validate(createSalaryStructureSchema), c.create);
router.put('/:id', checkPermission('payroll.edit'), validate(updateSalaryStructureSchema), c.update);

module.exports = router;
