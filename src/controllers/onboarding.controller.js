const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const onboardingService = require('../services/onboarding.service');
const onboardingMasterImportService = require('../services/onboardingMasterImport.service');
const onboardingHistoricalMigrationService = require('../services/onboardingHistoricalMigration.service');

const session = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await onboardingService.getSession(req.companyId, req.user));
});

const start = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await onboardingService.startSession(req.companyId, req.user, req.body), 'Onboarding started');
});

const updateStep = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await onboardingService.updateStepProgress(req.companyId, req.user, req.body),
    'Onboarding step updated'
  );
});

const goLive = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await onboardingService.markGoLive(req.companyId, req.user), 'Go-live completed');
});

const listImportJobs = asyncHandler(async (req, res) => {
  ApiResponse.paginated(res, await onboardingService.listImportJobs(req.companyId, req.query));
});

const queueImportJob = asyncHandler(async (req, res) => {
  ApiResponse.created(res, await onboardingService.queueImportJob(req.companyId, req.user, req.body));
});

const getImportJob = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await onboardingService.getImportJob(req.companyId, req.params.id));
});

const listReconciliations = asyncHandler(async (req, res) => {
  ApiResponse.paginated(res, await onboardingService.listReconciliations(req.companyId, req.query));
});

const previewMasterImport = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await onboardingMasterImportService.previewMasterImport({
      companyId: req.companyId,
      fileBase64: req.body.fileBase64,
      sheetName: req.body.sheet,
      entityType: req.body.entityType
    }),
    'Preview generated'
  );
});

const commitMasterImport = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await onboardingMasterImportService.commitMasterImport({
      companyId: req.companyId,
      reqUser: req.user,
      fileBase64: req.body.fileBase64,
      sheetName: req.body.sheet,
      entityType: req.body.entityType,
      mappingFromClient: req.body.mapping,
      mode: req.body.mode,
      skipDuplicates: req.body.skipDuplicates,
      options: req.body.options
    }),
    'Import finished'
  );
});

const previewHistoricalImport = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await onboardingHistoricalMigrationService.previewHistoricalImport({
      fileBase64: req.body.fileBase64,
      sheetName: req.body.sheet,
      entityType: req.body.entityType,
      fromDate: req.body.fromDate,
      toDate: req.body.toDate
    }),
    'Historical preview generated'
  );
});

const archiveHistoricalImport = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await onboardingHistoricalMigrationService.archiveHistoricalImport({
      companyId: req.companyId,
      reqUser: req.user,
      fileBase64: req.body.fileBase64,
      sheetName: req.body.sheet,
      entityType: req.body.entityType,
      fromDate: req.body.fromDate,
      toDate: req.body.toDate,
      archiveMode: req.body.archiveMode,
      fileMeta: req.body.file || {}
    }),
    'Historical data archived'
  );
});

const listHistoricalArchives = asyncHandler(async (req, res) => {
  ApiResponse.paginated(res, await onboardingHistoricalMigrationService.listHistoricalArchives(req.companyId, req.query));
});

const opsSummary = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await onboardingService.getOpsSummary(req.companyId));
});

const rollbackImportJob = asyncHandler(async (req, res) => {
  ApiResponse.success(
    res,
    await onboardingService.rollbackImportJob(req.companyId, req.params.id, req.user, req.body?.reason || ''),
    'Rollback completed'
  );
});

module.exports = {
  session,
  start,
  updateStep,
  goLive,
  listImportJobs,
  queueImportJob,
  getImportJob,
  listReconciliations,
  previewMasterImport,
  commitMasterImport,
  previewHistoricalImport,
  archiveHistoricalImport,
  listHistoricalArchives,
  opsSummary,
  rollbackImportJob
};
