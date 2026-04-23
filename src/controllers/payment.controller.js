const paymentService = require('../services/payment.service');
const auditService = require('../services/audit.service');
const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const result = await paymentService.list(req.companyId, req.query);
  ApiResponse.paginated(res, result);
});

const create = asyncHandler(async (req, res) => {
  const payment = await paymentService.create(req.companyId, req.body, req.user);
  await auditService.log({
    companyId: req.companyId,
    userId: req.user.userId,
    action: 'payment.create',
    entityType: 'Collection',
    entityId: payment._id,
    changes: { after: payment.toObject() }
  });
  ApiResponse.created(res, payment, 'Payment recorded');
});

const getById = asyncHandler(async (req, res) => {
  const payment = await paymentService.getById(req.companyId, req.params.id);
  if (!payment) throw new ApiError(404, 'Payment not found');
  ApiResponse.success(res, payment);
});

const getByPharmacy = asyncHandler(async (req, res) => {
  const payments = await paymentService.getByPharmacy(req.companyId, req.params.id);
  ApiResponse.success(res, payments);
});

module.exports = { list, create, getById, getByPharmacy };
