const path = require('path');
const orderService = require('../services/order.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const result = await orderService.list(req.companyId, req.query, req.context.timeZone);
  ApiResponse.paginated(res, result);
});

const create = asyncHandler(async (req, res) => {
  const order = await orderService.create(req.companyId, req.body, req.user, req.context.timeZone);
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
  const delivery = await orderService.deliver(req.companyId, req.params.id, req.body, req.user, req.context.timeZone);
  ApiResponse.success(res, delivery, 'Order delivered successfully');
});

const returnOrder = asyncHandler(async (req, res) => {
  const returnRecord = await orderService.returnOrder(req.companyId, req.params.id, req.body.items, req.user, req.context.timeZone);
  ApiResponse.success(res, returnRecord, 'Return processed successfully');
});

const cancel = asyncHandler(async (req, res) => {
  await orderService.cancel(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, null, 'Order cancelled');
});

const downloadDeliveryInvoice = asyncHandler(async (req, res) => {
  const absPath = await orderService.ensureDeliveryInvoicePdfPath(
    req.companyId,
    req.params.orderId,
    req.params.deliveryId
  );
  const filename = path.basename(absPath);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.sendFile(absPath);
});

module.exports = { list, create, getById, update, deliver, returnOrder, cancel, downloadDeliveryInvoice };
