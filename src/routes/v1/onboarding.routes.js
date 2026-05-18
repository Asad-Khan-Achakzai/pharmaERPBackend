const express = require('express');
const router = express.Router();
const c = require('../../controllers/onboarding.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { requireOnboardingEnabled } = require('../../middleware/requireOnboardingEnabled');
const { checkPermission } = require('../../middleware/checkPermission');
const { validate, validateQuery } = require('../../middleware/validate');
const {
  startOnboardingSchema,
  updateOnboardingStepSchema,
  queueImportJobSchema,
  previewMasterImportSchema,
  commitMasterImportSchema,
  listImportJobsQuerySchema,
  listReconciliationsQuerySchema,
  previewHistoricalImportSchema,
  archiveHistoricalImportSchema,
  listHistoricalArchivesQuerySchema,
  rollbackImportJobSchema
} = require('../../validators/onboarding.validator');

router.use(authenticate, companyScope, requireOnboardingEnabled);

router.get('/session', checkPermission('onboarding.view'), c.session);
router.post('/start', checkPermission('onboarding.manage'), validate(startOnboardingSchema), c.start);
router.patch('/steps', checkPermission('onboarding.manage'), validate(updateOnboardingStepSchema), c.updateStep);
router.post('/go-live', checkPermission('onboarding.approveGoLive'), c.goLive);

router.get('/imports', checkPermission('onboarding.view'), validateQuery(listImportJobsQuerySchema), c.listImportJobs);
router.post('/imports', checkPermission('onboarding.import'), validate(queueImportJobSchema), c.queueImportJob);
router.post('/imports/preview', checkPermission('onboarding.import'), validate(previewMasterImportSchema), c.previewMasterImport);
router.post('/imports/commit', checkPermission('onboarding.import'), validate(commitMasterImportSchema), c.commitMasterImport);
router.get('/imports/:id', checkPermission('onboarding.view'), c.getImportJob);
router.post('/imports/:id/rollback', checkPermission('onboarding.rollback'), validate(rollbackImportJobSchema), c.rollbackImportJob);

router.get(
  '/reconciliations',
  checkPermission('onboarding.view'),
  validateQuery(listReconciliationsQuerySchema),
  c.listReconciliations
);
router.post(
  '/historical/preview',
  checkPermission('onboarding.import'),
  validate(previewHistoricalImportSchema),
  c.previewHistoricalImport
);
router.post(
  '/historical/archive',
  checkPermission('onboarding.import'),
  validate(archiveHistoricalImportSchema),
  c.archiveHistoricalImport
);
router.get(
  '/historical/archives',
  checkPermission('onboarding.view'),
  validateQuery(listHistoricalArchivesQuerySchema),
  c.listHistoricalArchives
);
router.get('/ops/summary', checkPermission('onboarding.manage'), c.opsSummary);

module.exports = router;
