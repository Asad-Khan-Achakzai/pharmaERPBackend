const attendanceService = require('../services/attendance.service');
const salaryStructureService = require('../services/salaryStructure.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../utils/ApiError');
const { userHasPermission } = require('../utils/effectivePermissions');

const assertEmployeeScope = (req, employeeId) => {
  if (userHasPermission(req.user, 'admin.access')) return;
  if (employeeId !== req.user.userId) throw new ApiError(403, 'You can only access your own attendance');
};

const tz = (req) => req.context.timeZone;

const mark = asyncHandler(async (req, res) => {
  const doc = await attendanceService.markSelf(req.companyId, req.user.userId, req.body, tz(req));
  ApiResponse.success(res, doc, 'Attendance saved');
});

const checkin = asyncHandler(async (req, res) => {
  const doc = await attendanceService.checkIn(req.companyId, req.user.userId, tz(req));
  ApiResponse.success(res, doc, 'Checked in');
});

const checkout = asyncHandler(async (req, res) => {
  const doc = await attendanceService.checkOut(req.companyId, req.user.userId, tz(req));
  ApiResponse.success(res, doc, 'Checked out');
});

const meToday = asyncHandler(async (req, res) => {
  const doc = await attendanceService.getMeToday(req.companyId, req.user.userId, tz(req));
  ApiResponse.success(res, doc);
});

const today = asyncHandler(async (req, res) => {
  const data = await attendanceService.listToday(req.companyId, tz(req));
  ApiResponse.success(res, data);
});

const report = asyncHandler(async (req, res) => {
  assertEmployeeScope(req, req.query.employeeId);
  const data = await attendanceService.report(req.companyId, req.query, tz(req));
  ApiResponse.success(res, data);
});

const monthlySummary = asyncHandler(async (req, res) => {
  assertEmployeeScope(req, req.query.employeeId);
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
  if (!userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Only administrators can mark employees absent');
  }
  const { employeeId } = req.body;
  if (!employeeId) throw new ApiError(400, 'employeeId is required');
  const doc = await attendanceService.adminMarkAbsentToday(req.companyId, employeeId, tz(req));
  ApiResponse.success(res, doc, 'Employee marked absent for today');
});

const adminSetTodayStatus = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Only administrators can set employee attendance');
  }
  const { employeeId, status } = req.body;
  const doc = await attendanceService.adminSetAttendanceToday(req.companyId, employeeId, status, tz(req));
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
