const notificationService = require('../services/notification.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');
const { READ_SOURCE } = require('../models/Notification');

const feed = asyncHandler(async (req, res) => {
  const data = await notificationService.feed(req.companyId, req.user.userId, req.query);
  ApiResponse.paginated(res, data);
});

const unreadCount = asyncHandler(async (req, res) => {
  const count = await notificationService.unreadCount(req.companyId, req.user.userId);
  ApiResponse.success(res, { count });
});

const markRead = asyncHandler(async (req, res) => {
  const source = req.body?.source || READ_SOURCE.IN_APP;
  const data = await notificationService.markRead(
    req.companyId,
    req.user.userId,
    req.params.id,
    source
  );
  ApiResponse.success(res, data, 'Marked as read');
});

const markAllRead = asyncHandler(async (req, res) => {
  const source = req.body?.source || READ_SOURCE.IN_APP;
  const data = await notificationService.markAllRead(req.companyId, req.user.userId, source);
  ApiResponse.success(res, data, 'All marked as read');
});

const getPreferences = asyncHandler(async (req, res) => {
  const data = await notificationService.getOrCreatePreferences(req.companyId, req.user.userId);
  ApiResponse.success(res, data);
});

const updatePreferences = asyncHandler(async (req, res) => {
  const data = await notificationService.updatePreferences(
    req.companyId,
    req.user.userId,
    req.body || {}
  );
  ApiResponse.success(res, data, 'Preferences updated');
});

module.exports = {
  feed,
  markRead,
  markAllRead,
  unreadCount,
  getPreferences,
  updatePreferences
};
