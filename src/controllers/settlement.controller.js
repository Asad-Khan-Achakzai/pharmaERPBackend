const settlementService = require('../services/settlement.service');
const auditService = require('../services/audit.service');
const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const result = await settlementService.list(req.companyId, req.query, req.context.timeZone);
  ApiResponse.paginated(res, result);
});

const create = asyncHandler(async (req, res) => {
  const doc = await settlementService.create(req.companyId, req.body, req.user);
  await auditService.log({
    companyId: req.companyId,
    userId: req.user.userId,
    action: 'settlement.create',
    entityType: 'Settlement',
    entityId: doc._id,
    changes: { after: doc.toObject() }
  });
  ApiResponse.created(res, doc, 'Settlement recorded');
});

const getById = asyncHandler(async (req, res) => {
  const doc = await settlementService.getById(req.companyId, req.params.id);
  if (!doc) throw new ApiError(404, 'Settlement not found');
  ApiResponse.success(res, doc);
});

module.exports = { list, create, getById };
