const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const deviceControlService = require('../services/deviceControl.service');

const listBindings = asyncHandler(async (req, res) => {
  const result = await deviceControlService.listBindings({ companyId: req.companyId, query: req.query });
  ApiResponse.paginated(res, result, 'Device bindings');
});

const listRequests = asyncHandler(async (req, res) => {
  const result = await deviceControlService.listRequests({ companyId: req.companyId, query: req.query });
  ApiResponse.paginated(res, result, 'Device change requests');
});

const approveRequest = asyncHandler(async (req, res) => {
  const data = await deviceControlService.approveRequest({
    companyId: req.companyId,
    requestId: req.params.id,
    adminUserId: req.user.userId
  });
  ApiResponse.success(res, data, 'Device change approved');
});

const rejectRequest = asyncHandler(async (req, res) => {
  const data = await deviceControlService.rejectRequest({
    companyId: req.companyId,
    requestId: req.params.id,
    adminUserId: req.user.userId,
    note: req.body.note
  });
  ApiResponse.success(res, data, 'Device change rejected');
});

const forceRevoke = asyncHandler(async (req, res) => {
  const data = await deviceControlService.forceRevoke({
    companyId: req.companyId,
    userId: req.params.userId,
    adminUserId: req.user.userId
  });
  ApiResponse.success(res, data, 'Device revoked');
});

module.exports = {
  listBindings,
  listRequests,
  approveRequest,
  rejectRequest,
  forceRevoke
};
