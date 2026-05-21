const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const mediaService = require('../services/media.service');

const presign = asyncHandler(async (req, res) => {
  const { kind, mime, size } = req.body;
  const data = await mediaService.presign({ req, kind, mime, size });
  ApiResponse.success(res, data, 'Presigned');
});

const finalize = asyncHandler(async (req, res) => {
  const { assetId, size, mime, width, height } = req.body;
  const data = await mediaService.finalize({ req, assetId, size, mime, width, height });
  ApiResponse.success(res, data, 'Finalized');
});

const signedUrl = asyncHandler(async (req, res) => {
  const data = await mediaService.getSignedUrl({ req, key: req.params.key });
  ApiResponse.success(res, data);
});

const link = asyncHandler(async (req, res) => {
  const { resource, id, assetIds } = req.body;
  const data = await mediaService.linkToResource({ req, resource, id, assetIds });
  ApiResponse.success(res, data, 'Linked');
});

module.exports = { presign, finalize, signedUrl, link };
