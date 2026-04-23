const express = require('express');
const router = express.Router();
const c = require('../../controllers/expense.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createExpenseSchema, updateExpenseSchema } = require('../../validators/expense.validator');

router.use(authenticate, companyScope);
router.get('/', checkPermission('expenses.view'), c.list);
router.post('/', checkPermission('expenses.create'), validate(createExpenseSchema), c.create);
router.put('/:id', checkPermission('expenses.edit'), validate(updateExpenseSchema), c.update);
router.delete('/:id', checkPermission('expenses.delete'), c.remove);

module.exports = router;
