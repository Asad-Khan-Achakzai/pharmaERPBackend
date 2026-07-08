const express = require('express');
const router = express.Router();
const c = require('../../controllers/visit.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate, validateQuery } = require('../../middleware/validate');
const { unplannedVisitSchema } = require('../../validators/planItem.validator');
const {
  upsertActiveVisitSchema,
  listActiveVisitQuerySchema
} = require('../../validators/activeVisit.validator');

router.use(authenticate, companyScope);
router.get(
  '/active',
  checkPermission('weeklyPlans.view'),
  validateQuery(listActiveVisitQuerySchema),
  c.listActive
);
router.get(
  '/active/team',
  checkPermission('weeklyPlans.view'),
  validateQuery(listActiveVisitQuerySchema),
  c.listTeamActive
);
router.put('/active', checkPermission('weeklyPlans.markVisit'), validate(upsertActiveVisitSchema), c.upsertActive);
router.delete('/active/:clientUuid', checkPermission('weeklyPlans.markVisit'), c.clearActive);
router.post('/unplanned', checkPermission('weeklyPlans.markVisit'), validate(unplannedVisitSchema), c.unplanned);

module.exports = router;
