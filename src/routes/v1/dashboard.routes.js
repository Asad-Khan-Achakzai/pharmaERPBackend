const express = require('express');
const c = require('../../controllers/dashboardHome.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');

const router = express.Router();
router.use(authenticate, companyScope);
router.get('/home', checkPermission('dashboard.view'), c.home);

module.exports = router;
