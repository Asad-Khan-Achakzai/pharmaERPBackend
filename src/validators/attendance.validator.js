const Joi = require('joi');

const markAttendanceSchema = Joi.object({
  checkOutTime: Joi.date().optional(),
  notes: Joi.string().trim().max(500).allow(''),
  date: Joi.date().optional()
});

const reportQuerySchema = Joi.object({
  employeeId: Joi.string().required(),
  startDate: Joi.date().required(),
  endDate: Joi.date().required()
});

const monthlySummaryQuerySchema = Joi.object({
  employeeId: Joi.string().required(),
  month: Joi.string().pattern(/^\d{4}-\d{2}$/).required()
});

const adminMarkAbsentTodaySchema = Joi.object({
  employeeId: Joi.string().required()
});

const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE'];

const adminSetTodayStatusSchema = Joi.object({
  employeeId: Joi.string().required(),
  status: Joi.string().valid(...ATTENDANCE_STATUSES).required()
});

module.exports = {
  markAttendanceSchema,
  reportQuerySchema,
  monthlySummaryQuerySchema,
  adminMarkAbsentTodaySchema,
  adminSetTodayStatusSchema
};
