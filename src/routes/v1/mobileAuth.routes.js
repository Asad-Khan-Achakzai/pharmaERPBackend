const express = require('express');
const router = express.Router();

const controller = require('../../controllers/mobileAuth.controller');
const { authenticate } = require('../../middleware/auth');
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
 */
router.post('/login', validate(mobileLoginSchema), controller.login);
router.post('/refresh', validate(mobileRefreshSchema), controller.refresh);
router.post('/register-device', authenticate, validate(registerDeviceSchema), controller.registerDevice);
router.post('/logout', authenticate, validate(logoutSchema), controller.logout);
router.get('/sessions', authenticate, controller.listSessions);
router.delete('/sessions/:id', authenticate, controller.revokeSession);
router.post('/push-token', authenticate, validate(updatePushTokenSchema), controller.updatePushToken);
router.post(
  '/change-password',
  authenticate,
  validate(mobileChangePasswordSchema),
  controller.changePassword
);
router.post(
  '/switch-company',
  authenticate,
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
