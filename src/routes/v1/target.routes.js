const express = require('express');
const router = express.Router();
const c = require('../../controllers/target.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate, validateQuery } = require('../../middleware/validate');
const { createTargetSchema, updateTargetSchema, packsBreakdownQuerySchema } = require('../../validators/target.validator');

router.use(authenticate, companyScope);
router.get(
  '/packs-breakdown',
  checkPermission('targets.view'),
  validateQuery(packsBreakdownQuerySchema),
  c.packsBreakdown
);
router.get('/', checkPermission('targets.view'), c.list);
router.post('/', checkPermission('targets.create'), validate(createTargetSchema), c.create);
router.get('/rep/:id', checkPermission('targets.view'), c.getByRep);
router.put('/:id', checkPermission('targets.edit'), validate(updateTargetSchema), c.update);
router.delete('/:id', checkPermission('targets.edit'), c.remove);

module.exports = router;
