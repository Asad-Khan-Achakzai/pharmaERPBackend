const notificationService = require('../services/notification.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const feed = asyncHandler(async (req, res) => {
  const data = await notificationService.feed(req.companyId, req.user.userId, req.query);
  ApiResponse.paginated(res, data);
});

const markRead = asyncHandler(async (req, res) => {
  const data = await notificationService.markRead(req.companyId, req.user.userId, req.params.id);
  ApiResponse.success(res, data, 'Marked as read');
});

module.exports = { feed, markRead };
