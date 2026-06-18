const express = require('express');
const router = express.Router();

const controller = require('../../controllers/mobileAuth.controller');
const { authenticate } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const {
  mobileLoginSchema,
  registerDeviceSchema,
  mobileRefreshSchema,
  logoutSchema,
  updatePushTokenSchema,
  pushDiagnosticSchema,
  mobileChangePasswordSchema,
  mobileSwitchCompanySchema
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
  '/push-diagnostic',
  authenticate,
  validate(pushDiagnosticSchema),
  controller.reportPushDiagnostic
);
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

module.exports = router;
