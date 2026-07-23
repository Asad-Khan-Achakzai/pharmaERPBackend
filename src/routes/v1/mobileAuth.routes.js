const express = require('express');
const router = express.Router();

const controller = require('../../controllers/mobileAuth.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { deviceChangeAuth } = require('../../middleware/deviceChangeAuth');
const { validate } = require('../../middleware/validate');
const {
  mobileLoginSchema,
  registerDeviceSchema,
  mobileRefreshSchema,
  logoutSchema,
  updatePushTokenSchema,
  mobileChangePasswordSchema,
  mobileSwitchCompanySchema,
  deviceChangeRequestSchema
} = require('../../validators/mobileAuth.validator');

/**
 * Mobile-only auth surface. Existing web auth in /auth/* is untouched.
 * Authed routes go through companyScope so DEVICE_REBOUND applies — an old
 * device with an unexpired access token must not revoke the new device's session.
 */
router.post('/login', validate(mobileLoginSchema), controller.login);
router.post('/refresh', validate(mobileRefreshSchema), controller.refresh);
router.post(
  '/register-device',
  authenticate,
  companyScope,
  validate(registerDeviceSchema),
  controller.registerDevice
);
router.post('/logout', authenticate, companyScope, validate(logoutSchema), controller.logout);
router.get('/sessions', authenticate, companyScope, controller.listSessions);
router.delete('/sessions/:id', authenticate, companyScope, controller.revokeSession);
router.post(
  '/push-token',
  authenticate,
  companyScope,
  validate(updatePushTokenSchema),
  controller.updatePushToken
);
router.post(
  '/change-password',
  authenticate,
  companyScope,
  validate(mobileChangePasswordSchema),
  controller.changePassword
);
router.post(
  '/switch-company',
  authenticate,
  companyScope,
  validate(mobileSwitchCompanySchema),
  controller.switchCompany
);

/**
 * Device change request flow — authenticated by the short-lived device-change
 * token issued when a login was blocked (NOT the normal access token), so a
 * rep whose device is unregistered can request a switch without a session.
 */
router.post(
  '/device-change-request',
  deviceChangeAuth,
  validate(deviceChangeRequestSchema),
  controller.requestDeviceChange
);
router.get('/device-change-request', deviceChangeAuth, controller.getDeviceChangeRequest);
router.post('/device-change-request/cancel', deviceChangeAuth, controller.cancelDeviceChange);

module.exports = router;
