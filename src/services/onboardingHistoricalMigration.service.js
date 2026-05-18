const { DateTime } = require('luxon');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { loadRowsFromWorkbook } = require('./importEngine/adapterRunner');
const OnboardingSession = require('../models/OnboardingSession');
const ImportJob = require('../models/ImportJob');
const HistoricalImportArchive = require('../models/HistoricalImportArchive');
const MigrationAuditEvent = require('../models/MigrationAuditEvent');
const { IMPORT_MODE, IMPORT_JOB_STATUS } = require('../constants/onboarding');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 10000;
const PREVIEW_ROWS = 10;
const MAX_HISTORY_DAYS = 365;
const SUPPORTED = ['salesHistory', 'returnsHistory', 'collectionsHistory', 'visitsHistory', 'targetsHistory'];

const ensureSession = async (companyId, reqUser) => {
  const existing = await OnboardingSession.findOne({ companyId });
  if (existing) return existing;
  return OnboardingSession.create({ companyId, ownerUserId: reqUser.userId });
};

const validatePeriod = (fromDate, toDate) => {
  const from = DateTime.fromISO(String(fromDate || ''));
  const to = DateTime.fromISO(String(toDate || ''));
  if (!from.isValid || !to.isValid) throw new ApiError(400, 'fromDate and toDate must be valid ISO dates');
  if (to < from) throw new ApiError(400, 'toDate must be greater than or equal to fromDate');
  const days = Math.floor(to.endOf('day').diff(from.startOf('day'), 'days').days) + 1;
  if (days > MAX_HISTORY_DAYS) {
    throw new ApiError(400, `Historical window cannot exceed ${MAX_HISTORY_DAYS} days`);
  }
  if (to > DateTime.now().endOf('day')) {
    throw new ApiError(400, 'Historical window cannot include future dates');
  }
  return { fromDate: from.toISODate(), toDate: to.toISODate(), days };
};

const previewHistoricalImport = async ({ fileBase64, sheetName, entityType, fromDate, toDate }) => {
  if (!SUPPORTED.includes(entityType)) throw new ApiError(400, 'Unsupported historical entity type');
  const period = validatePeriod(fromDate, toDate);

  const { wb, sheet, headers, rows } = loadRowsFromWorkbook({
    fileBase64,
    sheetName,
    maxFileBytes: MAX_FILE_BYTES,
    maxRows: MAX_ROWS
  });

  const sampleRows = rows.slice(0, PREVIEW_ROWS).map((r) => ({ row: r.__rowNumber, ...r }));
  return {
    entityType,
    period,
    sheets: wb.SheetNames,
    sheet,
    headers,
    totalRows: rows.length,
    sampleRows,
    limits: { maxRows: MAX_ROWS, maxFileBytes: MAX_FILE_BYTES, maxHistoryDays: MAX_HISTORY_DAYS }
  };
};

const archiveHistoricalImport = async ({
  companyId,
  reqUser,
  fileBase64,
  sheetName,
  entityType,
  fromDate,
  toDate,
  archiveMode = 'ARCHIVE_ONLY',
  fileMeta = {}
}) => {
  if (!SUPPORTED.includes(entityType)) throw new ApiError(400, 'Unsupported historical entity type');
  const period = validatePeriod(fromDate, toDate);
  const session = await ensureSession(companyId, reqUser);

  const { sheet, headers, rows } = loadRowsFromWorkbook({
    fileBase64,
    sheetName,
    maxFileBytes: MAX_FILE_BYTES,
    maxRows: MAX_ROWS
  });

  const job = await ImportJob.create({
    companyId,
    onboardingSessionId: session._id,
    entityType,
    mode: IMPORT_MODE.COMMIT,
    status: IMPORT_JOB_STATUS.RUNNING,
    requestedBy: reqUser.userId,
    file: {
      originalName: fileMeta.originalName || `${entityType}.xlsx`,
      mimeType: fileMeta.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sizeBytes: fileMeta.sizeBytes || 0
    },
    summary: { archiveMode, sheet, period }
  });

  const archive = await HistoricalImportArchive.create({
    companyId,
    onboardingSessionId: session._id,
    importJobId: job._id,
    entityType,
    period,
    archiveMode,
    rowCount: rows.length,
    columns: headers,
    sampleRows: rows.slice(0, PREVIEW_ROWS),
    file: {
      originalName: fileMeta.originalName || `${entityType}.xlsx`,
      mimeType: fileMeta.mimeType || '',
      sizeBytes: fileMeta.sizeBytes || 0
    },
    metadata: {
      archivalNote: 'Archived for read-only legacy reporting. Not posted to live transactional collections.',
      sheet
    },
    createdBy: reqUser.userId
  });

  job.status = IMPORT_JOB_STATUS.COMPLETED;
  job.finishedAt = new Date();
  job.metrics = {
    totalRows: rows.length,
    validRows: rows.length,
    invalidRows: 0,
    skippedRows: 0,
    committedRows: 0
  };
  await job.save();

  await MigrationAuditEvent.create({
    companyId,
    onboardingSessionId: session._id,
    importJobId: job._id,
    eventType: 'IMPORT_COMPLETED',
    actorUserId: reqUser.userId,
    metadata: {
      entityType,
      period,
      archiveMode,
      rowCount: rows.length,
      archiveId: archive._id
    }
  });

  return {
    jobId: job._id,
    archiveId: archive._id,
    entityType,
    period,
    archiveMode,
    rowCount: rows.length
  };
};

const listHistoricalArchives = async (companyId, query) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId };
  if (query.entityType && SUPPORTED.includes(query.entityType)) filter.entityType = query.entityType;
  const [docs, total] = await Promise.all([
    HistoricalImportArchive.find(filter)
      .populate('createdBy', 'name email')
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    HistoricalImportArchive.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

module.exports = {
  previewHistoricalImport,
  archiveHistoricalImport,
  listHistoricalArchives,
  MAX_HISTORY_DAYS
};
