const orderService = require('../services/order.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const result = await orderService.list(req.companyId, req.query);
  ApiResponse.paginated(res, result);
});

const create = asyncHandler(async (req, res) => {
  const order = await orderService.create(req.companyId, req.body, req.user);
  ApiResponse.created(res, order);
});

const getById = asyncHandler(async (req, res) => {
  const order = await orderService.getById(req.companyId, req.params.id);
  ApiResponse.success(res, order);
});

const update = asyncHandler(async (req, res) => {
  const order = await orderService.update(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, order, 'Order updated');
});

const deliver = asyncHandler(async (req, res) => {
  const delivery = await orderService.deliver(req.companyId, req.params.id, req.body.items, req.user);
  ApiResponse.success(res, delivery, 'Order delivered successfully');
});

const returnOrder = asyncHandler(async (req, res) => {
  const returnRecord = await orderService.returnOrder(req.companyId, req.params.id, req.body.items, req.user);
  ApiResponse.success(res, returnRecord, 'Return processed successfully');
});

const cancel = asyncHandler(async (req, res) => {
  await orderService.cancel(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, null, 'Order cancelled');
});

module.exports = { list, create, getById, update, deliver, returnOrder, cancel };
