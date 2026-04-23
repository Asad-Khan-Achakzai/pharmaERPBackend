const express = require('express');
const router = express.Router();
const AuditLog = require('../../models/AuditLog');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const asyncHandler = require('../../middleware/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const { parsePagination } = require('../../utils/pagination');

router.use(authenticate, companyScope);

router.get('/', checkPermission('users.view'), asyncHandler(async (req, res) => {
  const { page, limit, skip, sort } = parsePagination(req.query);
  const filter = { companyId: req.companyId };
  if (req.query.entityType) filter.entityType = req.query.entityType;
  if (req.query.userId) filter.userId = req.query.userId;
  if (req.query.action) filter.action = { $regex: req.query.action, $options: 'i' };

  const [docs, total] = await Promise.all([
    AuditLog.find(filter).populate('userId', 'name').sort(sort).skip(skip).limit(limit),
    AuditLog.countDocuments(filter)
  ]);
  ApiResponse.paginated(res, { docs, total, page, limit });
}));

module.exports = router;
