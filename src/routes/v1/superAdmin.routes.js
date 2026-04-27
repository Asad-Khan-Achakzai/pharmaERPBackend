const express = require('express');
const router = express.Router();
const superAdminController = require('../../controllers/superAdmin.controller');
const { authenticate } = require('../../middleware/auth');
const { requireSuperAdmin } = require('../../middleware/requireSuperAdmin');
const { requireSuperAdminOrPlatformCompaniesManage } = require('../../middleware/requireSuperAdminOrPlatformCompaniesManage');
const { resolveHomePermissions } = require('../../middleware/resolveHomePermissions');
const { validate, validateQuery } = require('../../middleware/validate');
const {
  createCompanySchema,
  updateCompanySchema,
  switchCompanySchema,
  listPlatformUsersQuerySchema,
  createPlatformUserBodySchema,
  updatePlatformUserBodySchema
} = require('../../validators/superAdmin.validator');

const asSuperAdmin = [authenticate, requireSuperAdmin];
const asSuperOrPlatformCompanies = [
  authenticate,
  resolveHomePermissions,
  requireSuperAdminOrPlatformCompaniesManage
];

/** List + platform user CRUD: Super Admin, or `platform.companies.manage` (read-only list for company picker + management). */
router.get('/companies', asSuperOrPlatformCompanies, superAdminController.listCompanies);
router.post('/companies', asSuperAdmin, validate(createCompanySchema), superAdminController.createCompany);
router.patch('/companies/:id', asSuperAdmin, validate(updateCompanySchema), superAdminController.updateCompany);
router.get('/companies/:id/summary', asSuperAdmin, superAdminController.getCompanySummary);
router.post('/switch-company', asSuperAdmin, validate(switchCompanySchema), superAdminController.switchCompany);

router.get(
  '/platform-users',
  asSuperOrPlatformCompanies,
  validateQuery(listPlatformUsersQuerySchema),
  superAdminController.listPlatformUsers
);
router.get('/platform-users/:id', asSuperOrPlatformCompanies, superAdminController.getPlatformUser);
router.post(
  '/platform-users',
  asSuperOrPlatformCompanies,
  validate(createPlatformUserBodySchema),
  superAdminController.createPlatformUser
);
router.put(
  '/platform-users/:id',
  asSuperOrPlatformCompanies,
  validate(updatePlatformUserBodySchema),
  superAdminController.updatePlatformUser
);
router.delete('/platform-users/:id', asSuperOrPlatformCompanies, superAdminController.deletePlatformUser);

module.exports = router;
