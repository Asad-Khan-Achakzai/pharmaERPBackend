const express = require('express');
const router = express.Router();
const c = require('../../controllers/product.controller');
const presentationC = require('../../controllers/productPresentation.controller');
const engagementC = require('../../controllers/productEngagement.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission, allowLookupAccess } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createProductSchema, updateProductSchema } = require('../../validators/product.validator');
const {
  createPresentationSchema,
  updatePresentationSchema
} = require('../../validators/productPresentation.validator');
const { ingestEngagementSchema } = require('../../validators/productEngagement.validator');

router.use(authenticate, companyScope);

router.get('/lookup', allowLookupAccess, c.lookup);
router.get('/search', checkPermission('products.view'), c.search);
router.get('/compare', checkPermission('products.view'), c.compare);
router.get('/sync', checkPermission('products.view'), c.sync);
router.get('/catalog-sync', checkPermission('products.view'), c.catalogSync);
router.post(
  '/engagement',
  checkPermission('products.view'),
  validate(ingestEngagementSchema),
  engagementC.ingest
);

router.get('/', checkPermission('products.view'), c.list);
router.post('/', checkPermission('products.create'), validate(createProductSchema), c.create);

// Presentations nested under product
router.get(
  '/:productId/presentations',
  checkPermission('presentations.view'),
  presentationC.listForProduct
);
router.get(
  '/:productId/presentations/default',
  checkPermission('products.view'),
  presentationC.getDefault
);
router.post(
  '/:productId/presentations',
  checkPermission('presentations.edit'),
  validate(createPresentationSchema),
  presentationC.create
);

router.get('/:id', checkPermission('products.view'), c.getById);
router.put('/:id', checkPermission('products.edit'), validate(updateProductSchema), c.update);
router.delete('/:id', checkPermission('products.delete'), c.remove);

module.exports = router;
