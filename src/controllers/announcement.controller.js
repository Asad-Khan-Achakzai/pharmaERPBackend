const announcementService = require('../services/announcement.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const feed = asyncHandler(async (req, res) => {
  const data = await announcementService.feed(req.companyId, req.query);
  ApiResponse.paginated(res, data);
});

const adminList = asyncHandler(async (req, res) => {
  const data = await announcementService.adminList(req.companyId, req.query);
  ApiResponse.paginated(res, data);
});

const create = asyncHandler(async (req, res) => {
  const data = await announcementService.create(req.companyId, req.body, req.user);
  ApiResponse.created(res, data);
});

const publish = asyncHandler(async (req, res) => {
  const data = await announcementService.publish(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, data, 'Announcement published');
});

module.exports = { feed, adminList, create, publish };
