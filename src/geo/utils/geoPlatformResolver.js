const ApiError = require('../../utils/ApiError');
const { defaultFeaturesObject } = require('../config/geoFeatureRegistry');

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ACCURACY_METERS = 150;
const DEFAULT_HISTORY_MAX_ACCURACY_METERS = 500;
const DEFAULT_STALE_DISPLAY_MS = 30 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_SAMPLE_INTERVAL_MS = 60 * 1000;
const DEFAULT_UPLOAD_BATCH_INTERVAL_MS = 90 * 1000;

function pickMs(stored, prev, key, fallback) {
  if (stored != null && stored[key] != null) return Number(stored[key]);
  if (prev != null && prev[key] != null) return Number(prev[key]);
  return fallback;
}

function normalizeLiveTrackingSettings(stored, prev) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const s = stored && typeof stored === 'object' ? stored : {};
  const maxAccuracyMeters = pickMs(s, p, 'maxAccuracyMeters', DEFAULT_MAX_ACCURACY_METERS);
  let historyMaxAccuracyMeters = pickMs(
    s,
    p,
    'historyMaxAccuracyMeters',
    DEFAULT_HISTORY_MAX_ACCURACY_METERS
  );
  if (historyMaxAccuracyMeters < maxAccuracyMeters) {
    historyMaxAccuracyMeters = maxAccuracyMeters;
  }

  return {
    heartbeatIntervalMs: pickMs(s, p, 'heartbeatIntervalMs', DEFAULT_HEARTBEAT_INTERVAL_MS),
    maxAccuracyMeters,
    historyMaxAccuracyMeters,
    sampleIntervalMs: pickMs(s, p, 'sampleIntervalMs', DEFAULT_SAMPLE_INTERVAL_MS),
    uploadBatchIntervalMs: pickMs(s, p, 'uploadBatchIntervalMs', DEFAULT_UPLOAD_BATCH_INTERVAL_MS),
    trackingProfile: s.trackingProfile || p.trackingProfile || 'balanced',
    schedulerMinIntervalMs: pickMs(s, p, 'schedulerMinIntervalMs', 30_000),
    schedulerMaxIntervalMs: pickMs(s, p, 'schedulerMaxIntervalMs', 600_000),
    staleDisplayMs: pickMs(s, p, 'staleDisplayMs', DEFAULT_STALE_DISPLAY_MS),
    staleHideMs: pickMs(s, p, 'staleHideMs', DEFAULT_STALE_DISPLAY_MS * 2),
    retentionDays: pickMs(s, p, 'retentionDays', DEFAULT_RETENTION_DAYS),
    geofenceContextEnabled:
      s.geofenceContextEnabled !== undefined
        ? s.geofenceContextEnabled !== false
        : p.geofenceContextEnabled !== false,
    snapshotQualityGateEnabled:
      s.snapshotQualityGateEnabled !== undefined
        ? s.snapshotQualityGateEnabled !== false
        : p.snapshotQualityGateEnabled !== false,
    lowBatteryModeEnabled:
      s.lowBatteryModeEnabled !== undefined
        ? s.lowBatteryModeEnabled !== false
        : p.lowBatteryModeEnabled !== false
  };
}

function normalizeMapCenter(value) {
  if (value == null) {
    return { lat: null, lng: null };
  }
  if (typeof value === 'object') {
    const lat = value.lat != null ? Number(value.lat) : null;
    const lng = value.lng != null ? Number(value.lng) : null;
    return { lat, lng };
  }
  return { lat: null, lng: null };
}

function normalizeGeoDefaults(inputDefaults, prevDefaults, fallbackCountry) {
  const prev = prevDefaults && typeof prevDefaults === 'object' ? prevDefaults : {};
  const next = inputDefaults && typeof inputDefaults === 'object' ? inputDefaults : {};

  return {
    mapCenter: normalizeMapCenter(next.mapCenter ?? prev.mapCenter),
    mapZoom: next.mapZoom ?? prev.mapZoom ?? 12,
    countryCode: next.countryCode ?? prev.countryCode ?? fallbackCountry ?? 'PK'
  };
}

function resolveGeoPlatform(company) {
  if (!company) {
    return {
      enabled: false,
      configVersion: 1,
      defaults: { mapCenter: null, mapZoom: 12, countryCode: 'PK' },
      features: defaultFeaturesObject(),
      limits: { maxGoogleCallsPerDay: null },
      liveTracking: normalizeLiveTrackingSettings(null, null)
    };
  }

  const stored = company.geoPlatform && typeof company.geoPlatform === 'object' ? company.geoPlatform : {};
  const features = { ...defaultFeaturesObject(), ...(stored.features || {}) };

  if (features.managerLiveMap === true) {
    features.liveTracking = true;
  }

  const storedFeatureKeys = stored.features ? Object.keys(stored.features) : [];
  const hasStoredFeatures = storedFeatureKeys.length > 0;
  if (features.doctorMaps === true && !storedFeatureKeys.includes('pharmacyMaps')) {
    features.pharmacyMaps = true;
  }
  if (!hasStoredFeatures) {
    if (company.liveTrackingEnabled === true) {
      features.liveTracking = true;
      features.managerLiveMap = true;
    }
    if (company.geoFencingEnabled === true) {
      features.geofencing = true;
    }
    if (company.attendanceGeofenceEnabled === true) {
      features.geofencing = true;
      features.attendanceMaps = true;
    }
  }

  const masterEnabled =
    stored.enabled === true ||
    features.managerLiveMap === true ||
    features.liveTracking === true ||
    (stored.enabled !== false &&
      (company.liveTrackingEnabled === true ||
        company.geoFencingEnabled === true ||
        Object.values(features).some(Boolean)));

  return {
    enabled: masterEnabled,
    configVersion: stored.configVersion != null ? Number(stored.configVersion) : 1,
    defaults: {
      mapCenter: stored.defaults?.mapCenter
        ? normalizeMapCenter(stored.defaults.mapCenter)
        : { lat: null, lng: null },
      mapZoom: stored.defaults?.mapZoom ?? 12,
      countryCode: stored.defaults?.countryCode || company.country || 'PK'
    },
    features,
    limits: {
      maxGoogleCallsPerDay:
        stored.limits?.maxGoogleCallsPerDay != null ? Number(stored.limits.maxGoogleCallsPerDay) : null
    },
    liveTracking: normalizeLiveTrackingSettings(stored.liveTracking, null)
  };
}

function isGeoFeatureEnabled(company, featureKey) {
  const geo = resolveGeoPlatform(company);
  if (!geo.enabled) return false;
  return geo.features[featureKey] === true;
}

function assertGeoFeatureEnabled(company, featureKey) {
  if (!isGeoFeatureEnabled(company, featureKey)) {
    const err = new ApiError(403, `Geo feature "${featureKey}" is not enabled for this company`);
    err.code = 'GEO_FEATURE_DISABLED';
    err.data = { feature: featureKey };
    throw err;
  }
}

/** Single source for visit geofence enforcement (geoPlatform.features.geofencing + company mode). */
function resolveGeofenceConfig(company) {
  const { GEO_FENCE_MODE } = require('../../constants/enums');
  if (!company) {
    return {
      featureEnabled: false,
      active: false,
      mode: GEO_FENCE_MODE.OFF,
      radiusMeters: 150
    };
  }
  const featureEnabled = isGeoFeatureEnabled(company, 'geofencing');
  const mode = company.geoFenceMode || GEO_FENCE_MODE.OFF;
  const radiusMeters =
    Number(company.geoFenceRadiusMeters) > 0 ? Number(company.geoFenceRadiusMeters) : 150;
  const active =
    featureEnabled && (mode === GEO_FENCE_MODE.SOFT || mode === GEO_FENCE_MODE.STRICT);
  return { featureEnabled, active, mode, radiusMeters };
}

function buildGeoPlatformPatch(input, existingCompany) {
  if (!input || typeof input !== 'object') return null;

  const prev = existingCompany?.geoPlatform || {};
  const prevFeatures = { ...defaultFeaturesObject(), ...(prev.features || {}) };
  let nextFeatures = input.features ? { ...prevFeatures, ...input.features } : prevFeatures;
  if (nextFeatures.managerLiveMap === true) {
    nextFeatures = { ...nextFeatures, liveTracking: true };
  }

  const geoPlatform = {
    enabled: input.enabled != null ? !!input.enabled : prev.enabled === true,
    configVersion: (Number(prev.configVersion) || 1) + 1,
    defaults: normalizeGeoDefaults(input.defaults, prev.defaults, existingCompany?.country),
    features: nextFeatures,
    limits: {
      maxGoogleCallsPerDay:
        input.limits?.maxGoogleCallsPerDay !== undefined
          ? input.limits.maxGoogleCallsPerDay
          : prev.limits?.maxGoogleCallsPerDay ?? null
    },
    liveTracking: normalizeLiveTrackingSettings(input.liveTracking, prev.liveTracking)
  };

  const legacy = {
    liveTrackingEnabled: !!(
      geoPlatform.enabled &&
      (nextFeatures.liveTracking || nextFeatures.managerLiveMap)
    ),
    geoFencingEnabled: !!(geoPlatform.enabled && nextFeatures.geofencing),
    attendanceGeofenceEnabled: !!(geoPlatform.enabled && nextFeatures.attendanceMaps)
  };

  return { geoPlatform, legacy };
}

/** Sync legacy top-level booleans into geoPlatform when only legacy fields are patched. */
function syncLegacyFlagsToGeoPlatform(company) {
  const patch = buildGeoPlatformPatch(
    {
      enabled:
        company.liveTrackingEnabled ||
        company.geoFencingEnabled ||
        company.attendanceGeofenceEnabled ||
        company.geoPlatform?.enabled,
      features: {
        liveTracking: !!company.liveTrackingEnabled,
        managerLiveMap: !!company.liveTrackingEnabled,
        geofencing: !!company.geoFencingEnabled,
        attendanceMaps: !!company.attendanceGeofenceEnabled
      }
    },
    company
  );
  if (patch) {
    company.geoPlatform = patch.geoPlatform;
  }
}

module.exports = {
  resolveGeoPlatform,
  isGeoFeatureEnabled,
  assertGeoFeatureEnabled,
  resolveGeofenceConfig,
  buildGeoPlatformPatch,
  syncLegacyFlagsToGeoPlatform,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_ACCURACY_METERS,
  DEFAULT_HISTORY_MAX_ACCURACY_METERS,
  DEFAULT_SAMPLE_INTERVAL_MS,
  DEFAULT_UPLOAD_BATCH_INTERVAL_MS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_STALE_DISPLAY_MS
};
