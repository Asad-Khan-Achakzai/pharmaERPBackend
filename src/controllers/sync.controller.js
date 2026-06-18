const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const env = require('../config/env');
const { getMediaFlags } = require('../utils/mediaFlags');
const logger = require('../utils/logger');
const { getPushBackendStatus } = require('../utils/pushDiagnostics');

const serverConfig = asyncHandler(async (req, res) => {
  const company = req.context && req.context.company ? req.context.company : null;
  const media = getMediaFlags(company);
  const pushBackend = getPushBackendStatus();
  const companyPushEnabled = !!(company && company.mobilePushEnabled);

  if (companyPushEnabled && !pushBackend.backendReady) {
    logger.warn('push.server_config_misconfigured', {
      userId: String(req.user.userId),
      companyId: company ? String(company._id) : null,
      companyName: company?.name || null,
      ...pushBackend,
      fix: !pushBackend.expoSdkLoaded
        ? 'Install expo-server-sdk on backend'
        : 'Set EXPO_ACCESS_TOKEN on Render and redeploy'
    });
  }

  const payload = {
    serverTime: new Date().toISOString(),
    media,
    attendance: {
      geofenceEnabled: !!(company && company.attendanceGovernanceEnabled),
      selfieEnabled: media.enableMediaUpload && media.enableVisitPhotos,
      geofenceRadiusMeters: 150
    },
    doctors: {
      approvalRequired:
        company && typeof company.doctorApprovalRequired === 'boolean'
          ? company.doctorApprovalRequired
          : false
    },
    sync: {
      pageSize: env.MOBILE_SYNC_PAGE_SIZE,
      pollIntervalMs: env.MOBILE_SYNC_POLL_INTERVAL_MS
    },
    push: {
      enabled: companyPushEnabled,
      backendReady: pushBackend.backendReady,
      backend: pushBackend
    },
    liveTracking: {
      enabled: !!(company && company.liveTrackingEnabled),
      maxAccuracyMeters: 150,
      heartbeatIntervalMs: 5 * 60 * 1000
    },
    expenses: {
      approvalRequired: !!(company && company.expenseApprovalRequired)
    },
    company: company
      ? {
          id: String(company._id),
          name: company.name,
          status: 'LIVE',
          mobilePushEnabled: !!company.mobilePushEnabled,
          liveTrackingEnabled: !!company.liveTrackingEnabled,
          expenseApprovalRequired: !!company.expenseApprovalRequired
        }
      : null
  };
  logger.debug('sync.server_config', {
    userId: String(req.user.userId),
    companyId: company ? String(company._id) : null,
    pushEnabled: companyPushEnabled,
    pushBackendReady: pushBackend.backendReady
  });

  ApiResponse.success(res, payload);
});

const serverTime = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, { now: new Date().toISOString() });
});

module.exports = { serverConfig, serverTime };
