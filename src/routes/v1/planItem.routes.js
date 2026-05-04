const express = require('express');
const router = express.Router();
const c = require('../../controllers/planItem.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate, validateQuery } = require('../../middleware/validate');
const { markVisitSchema, listTodayQuerySchema, updatePlanItemSchema, reorderPlanItemsSchema } = require('../../validators/planItem.validator');

router.use(authenticate, companyScope);
router.get('/today', checkPermission('weeklyPlans.view'), validateQuery(listTodayQuerySchema), c.listToday);
router.put('/reorder', checkPermission('weeklyPlans.edit'), validate(reorderPlanItemsSchema), c.reorder);
router.put('/:id', checkPermission('weeklyPlans.edit'), validate(updatePlanItemSchema), c.update);
router.post('/:id/mark-visit', checkPermission('weeklyPlans.markVisit'), validate(markVisitSchema), c.markVisit);

module.exports = router;
