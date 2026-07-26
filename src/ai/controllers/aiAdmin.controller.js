const asyncHandler = require('../../middleware/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const AiInteractionLog = require('../models/AiInteractionLog');

const listLogs = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const limit = Math.min(50, parseInt(String(req.query.limit || '20'), 10));
  const skip = (page - 1) * limit;
  const filter = { companyId: req.companyId };
  const [docs, total] = await Promise.all([
    AiInteractionLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AiInteractionLog.countDocuments(filter)
  ]);
  ApiResponse.paginated(res, { docs, total, page, limit });
});

module.exports = { listLogs };
