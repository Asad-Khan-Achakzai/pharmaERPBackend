const express = require('express');
const router = express.Router();
const c = require('../../controllers/realtime.controller');
const { authenticateSse } = require('../../middleware/authenticateSse');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermissionAny } = require('../../middleware/checkPermission');

router.use(authenticateSse, companyScope);

router.get(
  '/stream',
  checkPermissionAny('team.view', 'team.viewAllReports', 'attendance.viewTeam', 'admin.access'),
  c.stream
);

router.get('/stats', checkPermissionAny('admin.access'), c.stats);

module.exports = router;
