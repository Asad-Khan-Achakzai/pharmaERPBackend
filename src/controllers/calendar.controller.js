const calendarService = require('../services/calendar.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

/**
 * GET /calendar/events
 * Read-only aggregated calendar payload (events + KPIs + rep directory).
 * Query: from, to (YYYY-MM-DD, required), scope (mine|team), repIds (csv), includeDoctorActivities.
 */
const getEvents = asyncHandler(async (req, res) => {
  const data = await calendarService.getCalendar(
    req.companyId,
    req.user,
    req.query,
    req.context.timeZone
  );
  ApiResponse.success(res, data);
});

module.exports = { getEvents };
