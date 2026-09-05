const remittanceService = require('../services/remittance.service');
const auditService = require('../services/audit.service');
const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../middleware/asyncHandler');

const preview = asyncHandler(async (req, res) => {
  const data = await remittanceService.preview(req.companyId, req.body);
  ApiResponse.success(res, data);
});

const create = asyncHandler(async (req, res) => {
  const doc = await remittanceService.create(req.companyId, req.body, req.user);
  await auditService.log({
    companyId: req.companyId,
    userId: req.user.userId,
    action: 'remittance.create',
    entityType: 'Remittance',
    entityId: doc._id,
    changes: {
      after: {
        distributorId: doc.distributorId,
        collectedAmount: doc.collectedAmount,
        expectedAmount: doc.expectedAmount,
        receivedAmount: doc.receivedAmount,
        differenceAmount: doc.differenceAmount,
        settlementId: doc.settlementId
      }
    }
  });
  ApiResponse.created(res, doc, 'Remittance recorded');
});

const list = asyncHandler(async (req, res) => {
  const result = await remittanceService.list(req.companyId, req.query, req.context.timeZone);
  ApiResponse.paginated(res, result);
});

const getById = asyncHandler(async (req, res) => {
  const doc = await remittanceService.getById(req.companyId, req.params.id);
  if (!doc) throw new ApiError(404, 'Remittance not found');
  ApiResponse.success(res, doc);
});

const reverse = asyncHandler(async (req, res) => {
  const before = await remittanceService.getById(req.companyId, req.params.id);
  if (!before) throw new ApiError(404, 'Remittance not found');
  const result = await remittanceService.reverse(req.companyId, req.params.id, req.body, req.user);
  await auditService.log({
    companyId: req.companyId,
    userId: req.user.userId,
    action: 'remittance.reverse',
    entityType: 'Remittance',
    entityId: before._id,
    changes: {
      before: {
        expectedAmount: before.expectedAmount,
        receivedAmount: before.receivedAmount,
        settlementId: before.settlementId
      },
      meta: { reversalReason: req.body?.reversalReason || null }
    }
  });
  ApiResponse.success(res, result, 'Remittance reversed');
});

const pharmacyOutstanding = asyncHandler(async (req, res) => {
  const data = await remittanceService.pharmacyOutstanding(req.companyId, req.params.distributorId, req.query);
  ApiResponse.paginated(res, data);
});

const unremittedCollections = asyncHandler(async (req, res) => {
  const data = await remittanceService.unremittedCollections(req.companyId, req.params.distributorId, req.query);
  ApiResponse.paginated(res, data);
});

module.exports = {
  preview,
  create,
  list,
  getById,
  reverse,
  pharmacyOutstanding,
  unremittedCollections
};
