const express = require('express');
const router = express.Router();

const c = require('../../controllers/callPoint.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission, allowLookupAccess } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createCallPointSchema, updateCallPointSchema } = require('../../validators/callPoint.validator');

router.use(authenticate, companyScope);

/** Active-only autocomplete for weekly plan day-CP dropdowns (no callPoints.view required). */
router.get('/lookup', allowLookupAccess, c.lookup);

router.get('/', checkPermission('callPoints.view'), c.list);
router.post('/', checkPermission('callPoints.create'), validate(createCallPointSchema), c.create);
router.get('/:id', checkPermission('callPoints.view'), c.getById);
router.put('/:id', checkPermission('callPoints.edit'), validate(updateCallPointSchema), c.update);
router.delete('/:id', checkPermission('callPoints.delete'), c.remove);

module.exports = router;
