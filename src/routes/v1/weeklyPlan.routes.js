const express = require('express');
const router = express.Router();
const Joi = require('joi');
const c = require('../../controllers/weeklyPlan.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { createWeeklyPlanSchema, updateWeeklyPlanSchema } = require('../../validators/target.validator');
const { bulkPlanItemsSchema } = require('../../validators/planItem.validator');
const { optimizeRouteSchema } = require('../../validators/phase2.validator');

const rejectPlanSchema = Joi.object({
  reason: Joi.string().required().trim().min(1).max(1000)
});

router.use(authenticate, companyScope);

/** Manager review queue — list plans pending approval in caller's subtree. */
router.get('/pending-approvals', checkPermission('weeklyPlans.review'), c.pendingApprovals);

router.get('/', checkPermission('weeklyPlans.view'), c.list);
router.post('/', checkPermission('weeklyPlans.create'), validate(createWeeklyPlanSchema), c.create);
router.get('/rep/:id', checkPermission('weeklyPlans.view'), c.getByRep);
router.post('/:id/plan-items', checkPermission('weeklyPlans.edit'), validate(bulkPlanItemsSchema), c.bulkPlanItems);
router.post('/:id/copy-previous-week', checkPermission('weeklyPlans.edit'), c.copyPreviousWeek);
router.post('/:id/optimize-route', checkPermission('weeklyPlans.edit'), validate(optimizeRouteSchema), c.optimizeRoute);

/** Phase 2B approval workflow — opt-in per company via Company.weeklyPlanApprovalRequired. */
router.post('/:id/submit', checkPermission('weeklyPlans.edit'), c.submit);
router.post('/:id/approve', checkPermission('weeklyPlans.approve'), c.approve);
router.post('/:id/reject', checkPermission('weeklyPlans.approve'), validate(rejectPlanSchema), c.reject);

router.get('/:id', checkPermission('weeklyPlans.view'), c.getById);
router.put('/:id', checkPermission('weeklyPlans.edit'), validate(updateWeeklyPlanSchema), c.update);

module.exports = router;
