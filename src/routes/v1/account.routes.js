const express = require('express');
const router = express.Router();
const c = require('../../controllers/account.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission, checkPermissionAny } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const {
  createAccountSchema,
  updateAccountSchema,
  openingBalanceSchema
} = require('../../validators/account.validator');
const { createSimpleAccountSchema } = require('../../validators/simpleAccount.validator');

router.use(authenticate, companyScope);
router.get('/group-types', checkPermission('accounts.view'), c.groupTypes);
router.get('/simple-types', checkPermissionAny('reports.view', 'accounts.view', 'payments.create', 'expenses.view'), c.simpleTypes);
router.get('/business-view', checkPermissionAny('reports.view', 'accounts.view', 'payments.view', 'expenses.view'), c.businessView);
router.get('/money-accounts', checkPermissionAny('payments.view', 'payments.create', 'accounts.view', 'vouchers.create'), c.listMoneyAccounts);
router.get('/tree', checkPermission('accounts.view'), c.tree);
router.get('/', checkPermission('accounts.view'), c.list);
router.get('/:id', checkPermission('accounts.view'), c.getById);
router.post('/simple', checkPermissionAny('accounts.manage', 'payments.create'), validate(createSimpleAccountSchema), c.createSimple);
router.post('/', checkPermission('accounts.manage'), validate(createAccountSchema), c.create);
router.patch('/:id', checkPermission('accounts.manage'), validate(updateAccountSchema), c.update);
router.patch('/:id/opening-balance', checkPermission('accounts.manage'), validate(openingBalanceSchema), c.setOpeningBalance);
router.delete('/:id', checkPermission('accounts.manage'), c.remove);

module.exports = router;
