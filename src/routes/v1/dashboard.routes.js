const express = require('express');
const c = require('../../controllers/dashboardHome.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validateQuery } = require('../../middleware/validate');
const { dashboardQuerySchema } = require('../../validators/reportDashboard.validator');

const router = express.Router();
router.use(authenticate, companyScope);
router.get('/home', checkPermission('dashboard.view'), validateQuery(dashboardQuerySchema), c.home);

module.exports = router;
