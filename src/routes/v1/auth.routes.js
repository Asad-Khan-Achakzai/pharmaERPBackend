const express = require('express');
const router = express.Router();
const authController = require('../../controllers/auth.controller');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/auth');
const {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  changePasswordSchema,
  switchCompanySchema
} = require('../../validators/auth.validator');

router.post('/register', validate(registerSchema), authController.register);
router.post('/login', validate(loginSchema), authController.login);
router.post('/refresh-token', validate(refreshTokenSchema), authController.refreshToken);
router.get('/me', authenticate, authController.getMe);
router.put('/change-password', authenticate, validate(changePasswordSchema), authController.changePassword);
router.post('/switch-company', authenticate, validate(switchCompanySchema), authController.switchCompany);

module.exports = router;
