const express = require('express');
const router = express.Router();
const c = require('../../controllers/productKit.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission, allowLookupAccess } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createKitSchema, updateKitSchema } = require('../../validators/productKit.validator');

router.use(authenticate, companyScope);
router.get('/lookup', allowLookupAccess, c.lookup);
router.get('/', checkPermission('kits.view'), c.list);
router.post('/', checkPermission('kits.create'), validate(createKitSchema), c.create);
router.get('/:id', checkPermission('kits.view'), c.getById);
router.put('/:id', checkPermission('kits.edit'), validate(updateKitSchema), c.update);
router.delete('/:id', checkPermission('kits.delete'), c.remove);

module.exports = router;
