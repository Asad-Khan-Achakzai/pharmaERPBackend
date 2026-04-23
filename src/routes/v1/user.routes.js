const express = require('express');
const router = express.Router();
const userController = require('../../controllers/user.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createUserSchema, updateUserSchema } = require('../../validators/user.validator');

router.use(authenticate, companyScope);

router.get('/', checkPermission('users.view'), userController.list);
router.post('/', checkPermission('users.create'), validate(createUserSchema), userController.create);
router.get('/:id', checkPermission('users.view'), userController.getById);
router.put('/:id', checkPermission('users.edit'), validate(updateUserSchema), userController.update);
router.delete('/:id', checkPermission('users.delete'), userController.remove);

module.exports = router;
