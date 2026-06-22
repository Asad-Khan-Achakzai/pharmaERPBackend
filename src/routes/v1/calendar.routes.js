const express = require('express');
const router = express.Router();
const c = require('../../controllers/calendar.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');

router.use(authenticate, companyScope);

/** Read-only aggregated calendar (plan items, attendance, doctor-activity overlays). */
router.get('/events', checkPermission('weeklyPlans.view'), c.getEvents);

module.exports = router;
