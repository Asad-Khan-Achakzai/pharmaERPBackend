const express = require('express');
const router = express.Router();
const c = require('../../controllers/remittance.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { clientUuid } = require('../../middleware/clientUuid');
const {
  createRemittanceSchema,
  previewRemittanceSchema,
  reverseRemittanceSchema
} = require('../../validators/remittance.validator');

router.use(authenticate, companyScope, clientUuid());
router.get('/', checkPermission('payments.view'), c.list);
router.post('/preview', checkPermission('payments.view'), validate(previewRemittanceSchema), c.preview);
router.get(
  '/distributors/:distributorId/pharmacy-outstanding',
  checkPermission('payments.view'),
  c.pharmacyOutstanding
);
router.get(
  '/distributors/:distributorId/unremitted-collections',
  checkPermission('payments.view'),
  c.unremittedCollections
);
router.post('/', checkPermission('payments.create'), validate(createRemittanceSchema), c.create);
router.post('/:id/reverse', checkPermission('payments.create'), validate(reverseRemittanceSchema), c.reverse);
router.get('/:id', checkPermission('payments.view'), c.getById);

module.exports = router;
