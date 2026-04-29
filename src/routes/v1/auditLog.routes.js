const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const AuditLog = require('../../models/AuditLog');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const asyncHandler = require('../../middleware/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const { parsePagination } = require('../../utils/pagination');
const {
  escapeRegex,
  qScalar,
  applyDateFieldRangeFromQuery
} = require('../../utils/listQuery');

router.use(authenticate, companyScope);

router.get('/', checkPermission('users.view'), asyncHandler(async (req, res) => {
  const { page, limit, skip, sort, search } = parsePagination(req.query);
  const searchTerm = qScalar(search);
  const filter = { companyId: req.companyId };
  if (req.query.entityType) filter.entityType = req.query.entityType;
  if (req.query.userId) filter.userId = req.query.userId;
  else {
    const createdByRaw = qScalar(req.query.createdBy);
    if (createdByRaw && mongoose.Types.ObjectId.isValid(createdByRaw)) {
      filter.userId = new mongoose.Types.ObjectId(createdByRaw);
    }
  }
  applyDateFieldRangeFromQuery(filter, req.query, 'timestamp');
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { action: { $regex: rx, $options: 'i' } },
      { entityType: { $regex: rx, $options: 'i' } }
    ];
  } else if (req.query.action) {
    filter.action = { $regex: req.query.action, $options: 'i' };
  }

  const [docs, total] = await Promise.all([
    AuditLog.find(filter).populate('userId', 'name').sort(sort).skip(skip).limit(limit),
    AuditLog.countDocuments(filter)
  ]);
  ApiResponse.paginated(res, { docs, total, page, limit });
}));

module.exports = router;
