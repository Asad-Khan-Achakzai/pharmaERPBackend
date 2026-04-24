const express = require('express');
const router = express.Router();
const c = require('../../controllers/distributor.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission, allowLookupAccess } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createDistributorSchema, updateDistributorSchema } = require('../../validators/distributor.validator');

router.use(authenticate, companyScope);
router.get('/lookup', allowLookupAccess, c.lookup);
router.get('/', checkPermission('distributors.view'), c.list);
router.post('/', checkPermission('distributors.create'), validate(createDistributorSchema), c.create);
router.get('/:id', checkPermission('distributors.view'), c.getById);
router.put('/:id', checkPermission('distributors.edit'), validate(updateDistributorSchema), c.update);
router.delete('/:id', checkPermission('distributors.delete'), c.remove);

module.exports = router;
