const express = require('express');
const router = express.Router();
const c = require('../../controllers/productPresentation.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { updatePresentationSchema } = require('../../validators/productPresentation.validator');

router.use(authenticate, companyScope);

router.get('/:id', checkPermission('products.view'), c.getById);
router.get('/:id/quality', checkPermission('presentations.edit'), c.quality);
router.put(
  '/:id',
  checkPermission('presentations.edit'),
  validate(updatePresentationSchema),
  c.update
);
router.post('/:id/publish', checkPermission('presentations.publish'), c.publish);
router.delete('/:id', checkPermission('presentations.edit'), c.remove);

module.exports = router;
