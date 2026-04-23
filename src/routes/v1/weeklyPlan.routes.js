const express = require('express');
const router = express.Router();
const c = require('../../controllers/weeklyPlan.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createWeeklyPlanSchema, updateWeeklyPlanSchema } = require('../../validators/target.validator');
const { bulkPlanItemsSchema } = require('../../validators/planItem.validator');

router.use(authenticate, companyScope);
router.get('/', checkPermission('weeklyPlans.view'), c.list);
router.post('/', checkPermission('weeklyPlans.create'), validate(createWeeklyPlanSchema), c.create);
router.get('/rep/:id', checkPermission('weeklyPlans.view'), c.getByRep);
router.post('/:id/plan-items', checkPermission('weeklyPlans.edit'), validate(bulkPlanItemsSchema), c.bulkPlanItems);
router.get('/:id', checkPermission('weeklyPlans.view'), c.getById);
router.put('/:id', checkPermission('weeklyPlans.edit'), validate(updateWeeklyPlanSchema), c.update);

module.exports = router;
