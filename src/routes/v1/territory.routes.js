const express = require('express');
const router = express.Router();

const c = require('../../controllers/territory.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission, allowLookupAccess } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createTerritorySchema, updateTerritorySchema } = require('../../validators/territory.validator');

router.use(authenticate, companyScope);

/** Tenant-scoped autocomplete for forms (no `territories.view` required — admin.access still bypasses). */
router.get('/lookup', allowLookupAccess, c.lookup);

router.get('/tree', checkPermission('territories.view'), c.tree);
router.get('/', checkPermission('territories.view'), c.list);
router.post('/', checkPermission('territories.manage'), validate(createTerritorySchema), c.create);
router.get('/:id', checkPermission('territories.view'), c.getById);
router.put('/:id', checkPermission('territories.manage'), validate(updateTerritorySchema), c.update);
router.delete('/:id', checkPermission('territories.manage'), c.remove);

module.exports = router;
