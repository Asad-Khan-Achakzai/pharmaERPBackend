const express = require('express');
const router = express.Router();
const c = require('../../controllers/visit.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { unplannedVisitSchema } = require('../../validators/planItem.validator');

router.use(authenticate, companyScope);
router.post('/unplanned', checkPermission('weeklyPlans.markVisit'), validate(unplannedVisitSchema), c.unplanned);

module.exports = router;
