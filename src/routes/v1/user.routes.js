const express = require('express');
const router = express.Router();
const userController = require('../../controllers/user.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission, checkPermissionAny, allowLookupAccess } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const {
  createUserSchema,
  updateUserSchema,
  updateUserStatusSchema,
  updateUserManagerSchema,
  updateUserTerritorySchema
} = require('../../validators/user.validator');

router.use(authenticate, companyScope);

router.get('/assignable', allowLookupAccess, userController.assignable);
/** Caller's reporting subtree. Permission `team.view` (admin.access bypass). */
router.get('/team', checkPermission('team.view'), userController.team);
router.get('/', checkPermission('users.view'), userController.list);
router.post('/', checkPermission('users.create'), validate(createUserSchema), userController.create);
router.patch(
  '/:id/status',
  checkPermissionAny('users.edit', 'users.delete'),
  validate(updateUserStatusSchema),
  userController.setStatus
);
/** Direct reports of a specific user. */
router.get('/:id/reports', checkPermission('team.view'), userController.reports);
/** Re-parent a user. Requires `team.manage` (RM by default). */
router.patch(
  '/:id/manager',
  checkPermission('team.manage'),
  validate(updateUserManagerSchema),
  userController.setManager
);
/** Set a user's territory (brick). Requires `team.manage`. */
router.patch(
  '/:id/territory',
  checkPermission('team.manage'),
  validate(updateUserTerritorySchema),
  userController.setTerritory
);
router.get('/:id', checkPermission('users.view'), userController.getById);
router.put('/:id', checkPermission('users.edit'), validate(updateUserSchema), userController.update);

module.exports = router;
