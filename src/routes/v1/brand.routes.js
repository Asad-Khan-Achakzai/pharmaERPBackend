const express = require('express');
const router = express.Router();
const c = require('../../controllers/brand.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission, allowLookupAccess } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createBrandSchema, updateBrandSchema } = require('../../validators/brand.validator');

router.use(authenticate, companyScope);
router.get('/lookup', allowLookupAccess, c.lookup);
router.get('/', checkPermission('brands.view'), c.list);
router.post('/', checkPermission('brands.create'), validate(createBrandSchema), c.create);
router.get('/:id', checkPermission('brands.view'), c.getById);
router.put('/:id', checkPermission('brands.edit'), validate(updateBrandSchema), c.update);
router.delete('/:id', checkPermission('brands.delete'), c.remove);

module.exports = router;
