const express = require('express');
const router = express.Router();
const c = require('../../controllers/expense.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createExpenseSchema, updateExpenseSchema } = require('../../validators/expense.validator');
const { rejectExpenseSchema } = require('../../validators/phase2.validator');

router.use(authenticate, companyScope);
router.get('/inbox', checkPermission('expenses.approve'), c.inbox);
router.get('/', checkPermission('expenses.view'), c.list);
router.post('/', checkPermission('expenses.create'), validate(createExpenseSchema), c.create);
router.post('/:id/approve', checkPermission('expenses.approve'), c.approve);
router.post('/:id/reject', checkPermission('expenses.approve'), validate(rejectExpenseSchema), c.reject);
router.put('/:id', checkPermission('expenses.edit'), validate(updateExpenseSchema), c.update);
router.delete('/:id', checkPermission('expenses.delete'), c.remove);

module.exports = router;
