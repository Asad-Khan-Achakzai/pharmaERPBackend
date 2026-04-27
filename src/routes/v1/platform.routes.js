const express = require('express');
const platformController = require('../../controllers/platform.controller');
const { authenticate } = require('../../middleware/auth');
const { resolveHomePermissions } = require('../../middleware/resolveHomePermissions');
const { requirePlatform } = require('../../middleware/requirePlatform');
const { checkPermission } = require('../../middleware/checkPermission');

const router = express.Router();

router.get(
  '/dashboard',
  authenticate,
  resolveHomePermissions,
  requirePlatform,
  checkPermission('platform.dashboard.view'),
  platformController.dashboard
);

module.exports = router;
