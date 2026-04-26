const express = require('express');
const router = express.Router();
const userController = require('../../controllers/user.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission, checkPermissionAny, allowLookupAccess } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createUserSchema, updateUserSchema, updateUserStatusSchema } = require('../../validators/user.validator');

router.use(authenticate, companyScope);

router.get('/assignable', allowLookupAccess, userController.assignable);
router.get('/', checkPermission('users.view'), userController.list);
router.post('/', checkPermission('users.create'), validate(createUserSchema), userController.create);
router.patch(
  '/:id/status',
  checkPermissionAny('users.edit', 'users.delete'),
  validate(updateUserStatusSchema),
  userController.setStatus
);
router.get('/:id', checkPermission('users.view'), userController.getById);
router.put('/:id', checkPermission('users.edit'), validate(updateUserSchema), userController.update);

module.exports = router;
