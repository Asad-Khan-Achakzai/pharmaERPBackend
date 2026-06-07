const attendanceService = require('../services/attendance.service');
const salaryStructureService = require('../services/salaryStructure.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../utils/ApiError');
const { userHasPermission } = require('../utils/effectivePermissions');
const { resolveAttendanceVisibleUserIds } = require('../utils/attendanceScope.util');

const assertCanViewEmployeeAttendance = async (req, employeeId) => {
  if (userHasPermission(req.user, 'admin.access')) return;
  if (userHasPermission(req.user, 'attendance.viewCompany')) return;
  if (String(employeeId) === String(req.user.userId)) return;
  const visible = await resolveAttendanceVisibleUserIds(req.companyId, req.user);
  if (!visible.some((id) => String(id) === String(employeeId))) {
    throw new ApiError(403, 'You cannot access this employee’s attendance');
  }
};

const tz = (req) => req.context.timeZone;

const mark = asyncHandler(async (req, res) => {
  const doc = await attendanceService.markSelf(req.companyId, req.user.userId, req.body, tz(req));
  ApiResponse.success(res, doc, 'Attendance saved');
});

const checkin = asyncHandler(async (req, res) => {
  const doc = await attendanceService.checkIn(req.companyId, req.user.userId, tz(req), req.body || {});
  ApiResponse.success(res, doc, 'Checked in');
});

const checkout = asyncHandler(async (req, res) => {
  const doc = await attendanceService.checkOut(
    req.companyId,
    req.user.userId,
    tz(req),
    req.body || {}
  );
  ApiResponse.success(res, doc, 'Checked out');
});

const meToday = asyncHandler(async (req, res) => {
  const doc = await attendanceService.getMeToday(req.companyId, req.user.userId, tz(req));
  ApiResponse.success(res, doc);
});

const today = asyncHandler(async (req, res) => {
  const visible = await resolveAttendanceVisibleUserIds(req.companyId, req.user);
  const data = await attendanceService.listToday(req.companyId, tz(req), visible);
  ApiResponse.success(res, data);
});

const report = asyncHandler(async (req, res) => {
  await assertCanViewEmployeeAttendance(req, req.query.employeeId);
  const data = await attendanceService.report(req.companyId, req.query, tz(req));
  ApiResponse.success(res, data);
});

const monthlySummary = asyncHandler(async (req, res) => {
  await assertCanViewEmployeeAttendance(req, req.query.employeeId);
  const structure = await salaryStructureService.getActiveForEmployee(req.companyId, req.query.employeeId);
  const rate = structure?.dailyAllowance ?? 0;
  const data = await attendanceService.monthlySummary(
    req.companyId,
    req.query.employeeId,
    req.query.month,
    rate,
    tz(req)
  );
  ApiResponse.success(res, data);
});

const adminMarkAbsentToday = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'admin.access') && !userHasPermission(req.user, 'attendance.override')) {
    throw new ApiError(403, 'Not allowed to change attendance for this employee');
  }
  const { employeeId } = req.body;
  if (!employeeId) throw new ApiError(400, 'employeeId is required');
  const doc = await attendanceService.adminMarkAbsentToday(req.companyId, employeeId, tz(req), req.user.userId);
  ApiResponse.success(res, doc, 'Employee marked absent for today');
});

const adminSetTodayStatus = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'admin.access') && !userHasPermission(req.user, 'attendance.override')) {
    throw new ApiError(403, 'Not allowed to change attendance for this employee');
  }
  const { employeeId, status } = req.body;
  const doc = await attendanceService.adminSetAttendanceToday(req.companyId, employeeId, status, tz(req), req.user.userId);
  ApiResponse.success(res, doc, 'Attendance updated');
});

module.exports = {
  mark,
  checkin,
  checkout,
  meToday,
  today,
  report,
  monthlySummary,
  adminMarkAbsentToday,
  adminSetTodayStatus
};
