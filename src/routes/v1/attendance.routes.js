const express = require('express');
const router = express.Router();
const c = require('../../controllers/attendance.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate, validateQuery } = require('../../middleware/validate');
const {
  markAttendanceSchema,
  reportQuerySchema,
  monthlySummaryQuerySchema,
  adminMarkAbsentTodaySchema,
  adminSetTodayStatusSchema
} = require('../../validators/attendance.validator');

router.use(authenticate, companyScope);

router.post('/mark', checkPermission('attendance.mark'), validate(markAttendanceSchema), c.mark);
/** Self-service: only `req.user.userId` — any authenticated company user may check in/out and read own today. */
router.post('/checkin', c.checkin);
router.post('/checkout', c.checkout);
router.get('/me/today', c.meToday);
router.get('/today', checkPermission('attendance.view'), c.today);
router.post(
  '/admin/mark-absent-today',
  checkPermission('admin.access'),
  validate(adminMarkAbsentTodaySchema),
  c.adminMarkAbsentToday
);
router.post(
  '/admin/set-today-status',
  checkPermission('admin.access'),
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
