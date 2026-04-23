const express = require('express');
const router = express.Router();
const c = require('../../controllers/attendance.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { adminRepOrPermission } = require('../../middleware/attendanceAccess');
const { validate, validateQuery } = require('../../middleware/validate');
const {
  markAttendanceSchema,
  reportQuerySchema,
  monthlySummaryQuerySchema,
  adminMarkAbsentTodaySchema,
  adminSetTodayStatusSchema
} = require('../../validators/attendance.validator');

router.use(authenticate, companyScope);

router.post('/mark', adminRepOrPermission('attendance.mark'), validate(markAttendanceSchema), c.mark);
router.post('/checkin', adminRepOrPermission('attendance.mark'), c.checkin);
router.post('/checkout', adminRepOrPermission('attendance.mark'), c.checkout);
router.get('/me/today', adminRepOrPermission('attendance.mark'), c.meToday);
router.get('/today', adminRepOrPermission('attendance.view'), c.today);
router.post(
  '/admin/mark-absent-today',
  adminRepOrPermission('attendance.view'),
  validate(adminMarkAbsentTodaySchema),
  c.adminMarkAbsentToday
);
router.post(
  '/admin/set-today-status',
  adminRepOrPermission('attendance.view'),
  validate(adminSetTodayStatusSchema),
  c.adminSetTodayStatus
);
router.get('/report', checkPermission('attendance.view'), validateQuery(reportQuerySchema), c.report);
router.get(
  '/monthly-summary',
  checkPermission('attendance.view'),
  validateQuery(monthlySummaryQuerySchema),
  c.monthlySummary
);

module.exports = router;
