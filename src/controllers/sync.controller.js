const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const env = require('../config/env');
const { getMediaFlags } = require('../utils/mediaFlags');

const serverConfig = asyncHandler(async (req, res) => {
  const company = req.context && req.context.company ? req.context.company : null;
  const media = getMediaFlags(company);
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
      enabled: !!(company && company.mobilePushEnabled)
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
  ApiResponse.success(res, payload);
});

const serverTime = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, { now: new Date().toISOString() });
});

module.exports = { serverConfig, serverTime };
