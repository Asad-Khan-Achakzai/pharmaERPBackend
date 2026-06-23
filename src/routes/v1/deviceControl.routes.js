const express = require('express');
const router = express.Router();

const controller = require('../../controllers/deviceControl.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate } = require('../../middleware/validate');
const { rejectRequestSchema } = require('../../validators/deviceControl.validator');

/**
 * Tenant admin device-control management. Web users only (no device binding on
 * the web surface). Gated on `deviceControl.manage` (admin.access satisfies it).
 */
router.use(authenticate, companyScope);

router.get('/bindings', checkPermission('deviceControl.manage'), controller.listBindings);
router.post(
  '/bindings/:userId/revoke',
  checkPermission('deviceControl.manage'),
  controller.forceRevoke
);
router.get('/requests', checkPermission('deviceControl.manage'), controller.listRequests);
router.post('/requests/:id/approve', checkPermission('deviceControl.manage'), controller.approveRequest);
router.post(
  '/requests/:id/reject',
  checkPermission('deviceControl.manage'),
  validate(rejectRequestSchema),
  controller.rejectRequest
);

module.exports = router;
