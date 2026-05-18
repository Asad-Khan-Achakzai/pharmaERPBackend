const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const OnboardingSession = require('../models/OnboardingSession');
const ImportJob = require('../models/ImportJob');
const ImportCommit = require('../models/ImportCommit');
const MigrationReconciliation = require('../models/MigrationReconciliation');
const MigrationAuditEvent = require('../models/MigrationAuditEvent');
const Product = require('../models/Product');
const Pharmacy = require('../models/Pharmacy');
const Distributor = require('../models/Distributor');
const User = require('../models/User');
const Doctor = require('../models/Doctor');
const Territory = require('../models/Territory');
const DistributorInventory = require('../models/DistributorInventory');
const Ledger = require('../models/Ledger');
const SupplierLedger = require('../models/SupplierLedger');
const Company = require('../models/Company');
const { ONBOARDING_STATUS, ONBOARDING_STEP, IMPORT_JOB_STATUS } = require('../constants/onboarding');
const { ROLES, LEDGER_REFERENCE_TYPE } = require('../constants/enums');

const STEP_TO_PROGRESS_KEY = {
  [ONBOARDING_STEP.COMPANY_SETUP]: 'companySetup',
  [ONBOARDING_STEP.MASTER_DATA]: 'masterData',
  [ONBOARDING_STEP.OPENING_STOCK]: 'openingStock',
  [ONBOARDING_STEP.OPENING_BALANCES]: 'openingBalances',
  [ONBOARDING_STEP.OPTIONAL_HISTORY]: 'optionalHistory',
  [ONBOARDING_STEP.VERIFICATION]: 'verification',
  [ONBOARDING_STEP.GO_LIVE]: 'goLive'
};

const ensureSession = async (companyId, reqUser) => {
  let session = await OnboardingSession.findOne({ companyId });
  if (session) return session;

  session = await OnboardingSession.create({
    companyId,
    ownerUserId: reqUser.userId,
    status: ONBOARDING_STATUS.DRAFT,
    currentStep: ONBOARDING_STEP.COMPANY_SETUP
  });
  await MigrationAuditEvent.create({
    companyId,
    onboardingSessionId: session._id,
    eventType: 'SESSION_STARTED',
    actorUserId: reqUser.userId,
    metadata: { source: 'api' }
  });
  return session;
};

const getSession = async (companyId, reqUser) => {
  const session = await ensureSession(companyId, reqUser);
  return session.toObject();
};

const startSession = async (companyId, reqUser, body = {}) => {
  const session = await ensureSession(companyId, reqUser);
  if (session.status === ONBOARDING_STATUS.DRAFT || session.status === ONBOARDING_STATUS.FAILED) {
    session.status = ONBOARDING_STATUS.IN_PROGRESS;
    session.startedAt = session.startedAt || new Date();
  }
  session.lastActivityAt = new Date();
  if (body.currentStep && Object.values(ONBOARDING_STEP).includes(body.currentStep)) {
    session.currentStep = body.currentStep;
  }
  if (body.metadata && typeof body.metadata === 'object') {
    session.metadata = { ...(session.metadata || {}), ...body.metadata };
  }
  await session.save();

  await MigrationAuditEvent.create({
    companyId,
    onboardingSessionId: session._id,
    eventType: 'STEP_UPDATED',
    actorUserId: reqUser.userId,
    metadata: { currentStep: session.currentStep, status: session.status }
  });
  return session.toObject();
};

const updateStepProgress = async (companyId, reqUser, body) => {
  const session = await ensureSession(companyId, reqUser);
  const step = body.step;
  const key = STEP_TO_PROGRESS_KEY[step];
  if (!key) throw new ApiError(400, 'Invalid onboarding step');

  const stepDoc = session.progress[key] || {};
  stepDoc.status = body.status;
  stepDoc.note = body.note || '';
  if (body.status === 'COMPLETED') {
    stepDoc.completedAt = new Date();
  }
  session.progress[key] = stepDoc;
  session.currentStep = body.currentStep || step;
  session.lastActivityAt = new Date();

  const allMandatoryDone = ['companySetup', 'masterData', 'openingStock', 'openingBalances', 'verification'].every(
    (k) => session.progress?.[k]?.status === 'COMPLETED'
  );
  if (allMandatoryDone && session.status !== ONBOARDING_STATUS.LIVE) {
    session.status = ONBOARDING_STATUS.READY_FOR_GO_LIVE;
  } else if (session.status === ONBOARDING_STATUS.DRAFT) {
    session.status = ONBOARDING_STATUS.IN_PROGRESS;
  }

  await session.save();
  await MigrationAuditEvent.create({
    companyId,
    onboardingSessionId: session._id,
    eventType: 'STEP_UPDATED',
    actorUserId: reqUser.userId,
    metadata: {
      step,
      stepStatus: body.status,
      currentStep: session.currentStep,
      onboardingStatus: session.status
    }
  });
  return session.toObject();
};

const markGoLive = async (companyId, reqUser) => {
  const session = await ensureSession(companyId, reqUser);
  if (session.status !== ONBOARDING_STATUS.READY_FOR_GO_LIVE) {
    throw new ApiError(400, 'Session is not ready for go-live');
  }
  session.status = ONBOARDING_STATUS.LIVE;
  session.currentStep = ONBOARDING_STEP.GO_LIVE;
  session.completedAt = new Date();
  session.lastActivityAt = new Date();
  session.progress.goLive.status = 'COMPLETED';
  session.progress.goLive.completedAt = new Date();
  await session.save();

  await MigrationAuditEvent.create({
    companyId,
    onboardingSessionId: session._id,
    eventType: 'GO_LIVE_COMPLETED',
    actorUserId: reqUser.userId,
    metadata: {}
  });
  return session.toObject();
};

const queueImportJob = async (companyId, reqUser, body) => {
  const session = await ensureSession(companyId, reqUser);
  const payload = {
    companyId,
    onboardingSessionId: session._id,
    entityType: body.entityType,
    mode: body.mode,
    status: IMPORT_JOB_STATUS.QUEUED,
    idempotencyKey: body.idempotencyKey || null,
    requestedBy: reqUser.userId,
    file: body.file || {},
    mapping: body.mapping || {},
    options: body.options || {}
  };
  const job = await ImportJob.create(payload);
  await MigrationAuditEvent.create({
    companyId,
    onboardingSessionId: session._id,
    importJobId: job._id,
    eventType: 'IMPORT_QUEUED',
    actorUserId: reqUser.userId,
    metadata: { entityType: job.entityType, mode: job.mode }
  });
  return job.toObject();
};

const listImportJobs = async (companyId, query) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId };
  if (query.entityType) filter.entityType = query.entityType;
  if (query.status) filter.status = query.status;
  if (query.onboardingSessionId && mongoose.Types.ObjectId.isValid(query.onboardingSessionId)) {
    filter.onboardingSessionId = new mongoose.Types.ObjectId(query.onboardingSessionId);
  }

  const [docs, total] = await Promise.all([
    ImportJob.find(filter).populate('requestedBy', 'name email').sort(sort).skip(skip).limit(limit).lean(),
    ImportJob.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const getImportJob = async (companyId, id) => {
  const doc = await ImportJob.findOne({ _id: id, companyId }).populate('requestedBy', 'name email').lean();
  if (!doc) throw new ApiError(404, 'Import job not found');
  return doc;
};

const listReconciliations = async (companyId, query) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId };
  if (query.entityType) filter.entityType = query.entityType;
  if (query.status) filter.status = query.status;

  const [docs, total] = await Promise.all([
    MigrationReconciliation.find(filter).populate('generatedBy', 'name email').sort(sort).skip(skip).limit(limit).lean(),
    MigrationReconciliation.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const getOpsSummary = async (companyId) => {
  const activeFilter = { companyId, isDeleted: { $ne: true } };
  const [byStatus, recentFailures, reconMismatchCount, dataCounts, company] = await Promise.all([
    ImportJob.aggregate([
      { $match: { companyId } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    ImportJob.find({ companyId, status: IMPORT_JOB_STATUS.FAILED })
      .select('entityType error finishedAt')
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean(),
    MigrationReconciliation.countDocuments({ companyId, status: { $in: ['MISMATCHED', 'REVIEW_REQUIRED'] } }),
    Promise.all([
      Product.countDocuments(activeFilter),
      Pharmacy.countDocuments(activeFilter),
      Distributor.countDocuments(activeFilter),
      User.countDocuments({ ...activeFilter, role: { $ne: ROLES.SUPER_ADMIN } }),
      Doctor.countDocuments(activeFilter),
      Territory.countDocuments(activeFilter),
      DistributorInventory.countDocuments({ ...activeFilter, quantity: { $gt: 0 } }),
      Promise.all([
        Ledger.countDocuments({ ...activeFilter, referenceType: LEDGER_REFERENCE_TYPE.OPENING_BALANCE }),
        SupplierLedger.countDocuments({ ...activeFilter, notes: /opening balance/i })
      ])
    ]),
    Company.findById(companyId).select('cashOpeningBalance').lean()
  ]);

  const [
    productsCount,
    pharmaciesCount,
    distributorsCount,
    employeesCount,
    doctorsCount,
    territoriesCount,
    openingStockCount,
    [ledgerOpeningBalanceCount, supplierOpeningBalanceCount]
  ] = dataCounts;

  const openingBalanceCount =
    ledgerOpeningBalanceCount + supplierOpeningBalanceCount + (Number(company?.cashOpeningBalance || 0) > 0 ? 1 : 0);

  const dataPresence = {
    products: { count: productsCount, satisfied: productsCount > 0 },
    pharmacies: { count: pharmaciesCount, satisfied: pharmaciesCount > 0 },
    distributors: { count: distributorsCount, satisfied: distributorsCount > 0 },
    employees: { count: employeesCount, satisfied: employeesCount > 0 },
    doctors: { count: doctorsCount, satisfied: doctorsCount > 0 },
    territories: { count: territoriesCount, satisfied: territoriesCount > 0 },
    openingStock: { count: openingStockCount, satisfied: openingStockCount > 0 },
    openingBalances: { count: openingBalanceCount, satisfied: openingBalanceCount > 0 }
  };

  const importDependency = {
    products: { unlocked: true, blockedBy: null },
    pharmacies: {
      unlocked: dataPresence.products.satisfied,
      blockedBy: dataPresence.products.satisfied ? null : 'products'
    },
    distributors: {
      unlocked: dataPresence.products.satisfied && dataPresence.pharmacies.satisfied,
      blockedBy: !dataPresence.products.satisfied ? 'products' : dataPresence.pharmacies.satisfied ? null : 'pharmacies'
    },
    employees: {
      unlocked: dataPresence.products.satisfied && dataPresence.pharmacies.satisfied && dataPresence.distributors.satisfied,
      blockedBy: !dataPresence.products.satisfied
        ? 'products'
        : !dataPresence.pharmacies.satisfied
          ? 'pharmacies'
          : dataPresence.distributors.satisfied
            ? null
            : 'distributors'
    },
    openingStock: {
      unlocked:
        dataPresence.products.satisfied &&
        dataPresence.pharmacies.satisfied &&
        dataPresence.distributors.satisfied &&
        dataPresence.employees.satisfied,
      blockedBy: !dataPresence.products.satisfied
        ? 'products'
        : !dataPresence.pharmacies.satisfied
          ? 'pharmacies'
          : !dataPresence.distributors.satisfied
            ? 'distributors'
            : dataPresence.employees.satisfied
              ? null
              : 'employees'
    },
    openingBalances: {
      unlocked:
        dataPresence.products.satisfied &&
        dataPresence.pharmacies.satisfied &&
        dataPresence.distributors.satisfied &&
        dataPresence.employees.satisfied &&
        dataPresence.openingStock.satisfied,
      blockedBy: !dataPresence.products.satisfied
        ? 'products'
        : !dataPresence.pharmacies.satisfied
          ? 'pharmacies'
          : !dataPresence.distributors.satisfied
            ? 'distributors'
            : !dataPresence.employees.satisfied
              ? 'employees'
              : dataPresence.openingStock.satisfied
                ? null
                : 'openingStock'
    }
  };

  return {
    jobsByStatus: byStatus,
    recentFailures,
    reconciliationAlerts: reconMismatchCount,
    dataPresence,
    importDependency
  };
};

const rollbackImportJob = async (companyId, importJobId, reqUser, reason = '') => {
  const [job, commit] = await Promise.all([
    ImportJob.findOne({ _id: importJobId, companyId }),
    ImportCommit.findOne({ importJobId, companyId })
  ]);
  if (!job) throw new ApiError(404, 'Import job not found');
  if (!commit) throw new ApiError(400, 'No committed rows found for this import job');

  let rolledBack = 0;
  const ids = Array.isArray(commit.insertedIds) ? commit.insertedIds : [];

  if (job.entityType === 'products') {
    const docs = await Product.find({ _id: { $in: ids }, companyId });
    for (const d of docs) {
      await d.softDelete(reqUser.userId);
      rolledBack += 1;
    }
  } else if (job.entityType === 'pharmacies') {
    const docs = await Pharmacy.find({ _id: { $in: ids }, companyId });
    for (const d of docs) {
      await d.softDelete(reqUser.userId);
      rolledBack += 1;
    }
  } else if (job.entityType === 'distributors') {
    const docs = await Distributor.find({ _id: { $in: ids }, companyId });
    for (const d of docs) {
      await d.softDelete(reqUser.userId);
      rolledBack += 1;
    }
  } else if (job.entityType === 'employees') {
    const docs = await User.find({ _id: { $in: ids }, companyId });
    for (const d of docs) {
      await d.softDelete(reqUser.userId);
      rolledBack += 1;
    }
  } else if (job.entityType === 'openingStock') {
    const docs = await DistributorInventory.find({ _id: { $in: ids }, companyId });
    for (const d of docs) {
      d.quantity = 0;
      d.avgCostPerUnit = 0;
      d.updatedBy = reqUser.userId;
      await d.save();
      rolledBack += 1;
    }
  } else if (job.entityType === 'openingBalances') {
    const [lCount, sCount] = await Promise.all([
      Ledger.updateMany({ _id: { $in: ids }, companyId }, { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: reqUser.userId } }),
      SupplierLedger.updateMany(
        { _id: { $in: ids }, companyId },
        { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: reqUser.userId } }
      )
    ]);
    rolledBack += (lCount.modifiedCount || 0) + (sCount.modifiedCount || 0);
  } else {
    throw new ApiError(400, `Rollback is not supported for ${job.entityType}`);
  }

  await MigrationAuditEvent.create({
    companyId,
    onboardingSessionId: commit.onboardingSessionId,
    importJobId: job._id,
    eventType: 'ROLLBACK_COMPLETED',
    actorUserId: reqUser.userId,
    metadata: { reason, rolledBack, entityType: job.entityType }
  });
  return { importJobId, entityType: job.entityType, rolledBack, reason };
};

module.exports = {
  getSession,
  startSession,
  updateStepProgress,
  markGoLive,
  queueImportJob,
  listImportJobs,
  getImportJob,
  listReconciliations,
  getOpsSummary,
  rollbackImportJob
};
