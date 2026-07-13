const express = require('express');
const router = express.Router();
const c = require('../../controllers/productTaxonomy.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission, allowLookupAccess } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const {
  createTaxonomySchema,
  updateTaxonomySchema
} = require('../../validators/productTaxonomy.validator');

router.use(authenticate, companyScope);
router.get('/lookup', allowLookupAccess, c.lookup);
router.get('/tree', checkPermission('productTaxonomy.view'), c.tree);
router.get('/', checkPermission('productTaxonomy.view'), c.list);
router.post('/', checkPermission('productTaxonomy.manage'), validate(createTaxonomySchema), c.create);
router.get('/:id', checkPermission('productTaxonomy.view'), c.getById);
router.put(
  '/:id',
  checkPermission('productTaxonomy.manage'),
  validate(updateTaxonomySchema),
  c.update
);
router.delete('/:id', checkPermission('productTaxonomy.manage'), c.remove);

module.exports = router;
