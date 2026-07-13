const express = require('express');
const router = express.Router();
const c = require('../../controllers/catalogCampaign.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const {
  createCampaignSchema,
  updateCampaignSchema
} = require('../../validators/catalogCampaign.validator');

router.use(authenticate, companyScope);
router.get('/active', checkPermission('products.view'), c.listActive);
router.get('/', checkPermission('campaigns.view'), c.list);
router.post('/', checkPermission('campaigns.create'), validate(createCampaignSchema), c.create);
router.get('/:id', checkPermission('campaigns.view'), c.getById);
router.put('/:id', checkPermission('campaigns.edit'), validate(updateCampaignSchema), c.update);
router.delete('/:id', checkPermission('campaigns.delete'), c.remove);

module.exports = router;
