const express = require('express');
const router = express.Router();

const c = require('../../controllers/managerFieldDay.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate, validateQuery } = require('../../middleware/validate');
const {
  upsertManagerFieldDaySchema,
  updateManagerFieldDaySchema,
  listManagerFieldDaysQuerySchema,
  meQuerySchema
} = require('../../validators/managerFieldDay.validator');

router.use(authenticate, companyScope);

router.get('/', checkPermission('managerFieldDays.view'), validateQuery(listManagerFieldDaysQuerySchema), c.list);
router.get(
  '/partner-listings',
  checkPermission('managerFieldDays.view'),
  validateQuery(listManagerFieldDaysQuerySchema),
  c.partnerListings
);
router.get('/me', checkPermission('managerFieldDays.view'), validateQuery(meQuerySchema), c.getMe);
router.put('/me', checkPermission('managerFieldDays.edit'), validate(upsertManagerFieldDaySchema), c.upsertMe);
router.get('/:id', checkPermission('managerFieldDays.view'), c.getById);
router.put('/:id', checkPermission('managerFieldDays.edit'), validate(updateManagerFieldDaySchema), c.updateById);
router.delete('/:id', checkPermission('managerFieldDays.edit'), c.removeById);

module.exports = router;
