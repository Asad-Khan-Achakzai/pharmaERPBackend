const express = require('express');
const router = express.Router();
const roleController = require('../../controllers/role.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission, checkPermissionAny } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createRoleSchema, updateRoleSchema } = require('../../validators/role.validator');

router.use(authenticate, companyScope);

router.get(
  '/',
  checkPermissionAny('users.view', 'roles.manage'),
  roleController.list
);
router.get(
  '/:id',
  checkPermissionAny('users.view', 'roles.manage'),
  roleController.getById
);
router.post('/', checkPermission('roles.manage'), validate(createRoleSchema), roleController.create);
router.put('/:id', checkPermission('roles.manage'), validate(updateRoleSchema), roleController.update);
router.delete('/:id', checkPermission('roles.manage'), roleController.remove);

module.exports = router;
