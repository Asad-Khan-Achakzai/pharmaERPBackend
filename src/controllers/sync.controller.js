const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const env = require('../config/env');
const { getMediaFlags } = require('../utils/mediaFlags');
const pushService = require('../services/push.service');
const { getPublicGeoConfig } = require('../geo/services/geoConfig.service');
const { resolveGeoPlatform } = require('../geo/utils/geoPlatformResolver');

const serverConfig = asyncHandler(async (req, res) => {
  const company = req.context && req.context.company ? req.context.company : null;
  const media = getMediaFlags(company);
  const geoPlatform = getPublicGeoConfig(company);
  const geoResolved = resolveGeoPlatform(company);
  const payload = {
    serverTime: new Date().toISOString(),
    media,
    geoPlatform,
    attendance: {
      geofenceEnabled: !!(company && company.attendanceGovernanceEnabled),
      selfieEnabled: media.enableMediaUpload && media.enableVisitPhotos,
      geofenceRadiusMeters: 150,
      systemMode:
        company && company.attendanceSystemMode === 'CHECKIN_POLICY_V2'
          ? 'CHECKIN_POLICY_V2'
          : 'LEGACY',
      configVersion: company && company.attendanceConfigVersion != null
        ? Number(company.attendanceConfigVersion)
        : 1,
      configUpdatedAt:
        company && company.updatedAt
          ? new Date(company.updatedAt).toISOString()
          : null
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
      enabled: !!(company && company.mobilePushEnabled),
      backendReady: pushService.isPushConfigured()
    },
    liveTracking: {
      enabled: !!(
        geoResolved.enabled &&
        (geoResolved.features.liveTracking || geoResolved.features.managerLiveMap)
      ),
      maxAccuracyMeters: geoResolved.liveTracking.maxAccuracyMeters,
      historyMaxAccuracyMeters: geoResolved.liveTracking.historyMaxAccuracyMeters,
      heartbeatIntervalMs: geoResolved.liveTracking.heartbeatIntervalMs,
      sampleIntervalMs: geoResolved.liveTracking.sampleIntervalMs,
      uploadBatchIntervalMs: geoResolved.liveTracking.uploadBatchIntervalMs,
      retentionDays: geoResolved.liveTracking.retentionDays,
      trackingProfile: geoResolved.liveTracking.trackingProfile,
      schedulerMinIntervalMs: geoResolved.liveTracking.schedulerMinIntervalMs,
      schedulerMaxIntervalMs: geoResolved.liveTracking.schedulerMaxIntervalMs,
      geofenceContextEnabled: geoResolved.liveTracking.geofenceContextEnabled,
      staleDisplayMs: geoResolved.liveTracking.staleDisplayMs
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
          liveTrackingEnabled: !!(
            geoResolved.enabled &&
            (geoResolved.features.liveTracking || geoResolved.features.managerLiveMap)
          ),
          expenseApprovalRequired: !!company.expenseApprovalRequired
        }
      : null
  };
  ApiResponse.success(res, payload);
});

const serverTime = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, { now: new Date().toISOString() });
});

module.exports = { serverConfig, serverTime };
