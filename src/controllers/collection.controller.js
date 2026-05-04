const collectionService = require('../services/collection.service');
const auditService = require('../services/audit.service');
const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const result = await collectionService.list(req.companyId, req.query, req.context.timeZone);
  ApiResponse.paginated(res, result);
});

const create = asyncHandler(async (req, res) => {
  const doc = await collectionService.create(req.companyId, req.body, req.user);
  await auditService.log({
    companyId: req.companyId,
    userId: req.user.userId,
    action: 'collection.create',
    entityType: 'Collection',
    entityId: doc._id,
    changes: { after: doc.toObject() }
  });
  ApiResponse.created(res, doc, 'Collection recorded');
});

const getById = asyncHandler(async (req, res) => {
  const doc = await collectionService.getById(req.companyId, req.params.id);
  if (!doc) throw new ApiError(404, 'Collection not found');
  ApiResponse.success(res, doc);
});

const getByPharmacy = asyncHandler(async (req, res) => {
  const docs = await collectionService.getByPharmacy(req.companyId, req.params.id);
  ApiResponse.success(res, docs);
});

module.exports = { list, create, getById, getByPharmacy };
