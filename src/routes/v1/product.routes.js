const express = require('express');
const router = express.Router();
const c = require('../../controllers/product.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createProductSchema, updateProductSchema } = require('../../validators/product.validator');

router.use(authenticate, companyScope);
router.get('/', checkPermission('products.view'), c.list);
router.post('/', checkPermission('products.create'), validate(createProductSchema), c.create);
router.get('/:id', checkPermission('products.view'), c.getById);
router.put('/:id', checkPermission('products.edit'), validate(updateProductSchema), c.update);
router.delete('/:id', checkPermission('products.delete'), c.remove);

module.exports = router;
