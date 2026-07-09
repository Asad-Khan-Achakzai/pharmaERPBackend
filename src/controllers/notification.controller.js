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

module.exports = { feed, markRead, unreadCount };
