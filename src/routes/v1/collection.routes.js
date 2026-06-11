const express = require('express');
const router = express.Router();
const c = require('../../controllers/collection.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const {
  createCollectionSchema,
  updateCollectionSchema,
  reverseCollectionSchema
} = require('../../validators/collection.validator');

router.use(authenticate, companyScope);
router.get('/', checkPermission('payments.view'), c.list);
router.post('/', checkPermission('payments.create'), validate(createCollectionSchema), c.create);
router.get('/pharmacy/:id', checkPermission('payments.view'), c.getByPharmacy);
router.patch('/:id', checkPermission('payments.create'), validate(updateCollectionSchema), c.update);
router.post('/:id/reverse', checkPermission('payments.create'), validate(reverseCollectionSchema), c.reverse);
router.get('/:id', checkPermission('payments.view'), c.getById);

module.exports = router;
