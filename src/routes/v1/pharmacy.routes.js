const express = require('express');
const router = express.Router();
const c = require('../../controllers/pharmacy.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission, allowLookupAccess } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createPharmacySchema, updatePharmacySchema } = require('../../validators/pharmacy.validator');

router.use(authenticate, companyScope);
router.get('/lookup', allowLookupAccess, c.lookup);
router.get('/', checkPermission('pharmacies.view'), c.list);
router.post('/', checkPermission('pharmacies.create'), validate(createPharmacySchema), c.create);
router.get('/:id', checkPermission('pharmacies.view'), c.getById);
router.put('/:id', checkPermission('pharmacies.edit'), validate(updatePharmacySchema), c.update);
router.delete('/:id', checkPermission('pharmacies.delete'), c.remove);

module.exports = router;
