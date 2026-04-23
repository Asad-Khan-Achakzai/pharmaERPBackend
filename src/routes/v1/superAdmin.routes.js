const express = require('express');
const router = express.Router();
const superAdminController = require('../../controllers/superAdmin.controller');
const { authenticate } = require('../../middleware/auth');
const { requireSuperAdmin } = require('../../middleware/requireSuperAdmin');
const { validate } = require('../../middleware/validate');
const {
  createCompanySchema,
  updateCompanySchema,
  switchCompanySchema
} = require('../../validators/superAdmin.validator');

router.use(authenticate, requireSuperAdmin);

router.get('/companies', superAdminController.listCompanies);
router.post('/companies', validate(createCompanySchema), superAdminController.createCompany);
router.patch('/companies/:id', validate(updateCompanySchema), superAdminController.updateCompany);
router.get('/companies/:id/summary', superAdminController.getCompanySummary);
router.post('/switch-company', validate(switchCompanySchema), superAdminController.switchCompany);

module.exports = router;
