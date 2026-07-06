const ApiError = require('../../utils/ApiError');
const { defaultFeaturesObject } = require('../config/geoFeatureRegistry');

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ACCURACY_METERS = 150;

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
      liveTracking: {
        heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
        maxAccuracyMeters: DEFAULT_MAX_ACCURACY_METERS
      }
    };
  }

  const stored = company.geoPlatform && typeof company.geoPlatform === 'object' ? company.geoPlatform : {};
  const features = { ...defaultFeaturesObject(), ...(stored.features || {}) };

  if (features.managerLiveMap === true) {
    features.liveTracking = true;
  }

  const hasStoredFeatures = stored.features && Object.keys(stored.features).length > 0;
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
    liveTracking: {
      heartbeatIntervalMs:
        stored.liveTracking?.heartbeatIntervalMs != null
          ? Number(stored.liveTracking.heartbeatIntervalMs)
          : DEFAULT_HEARTBEAT_INTERVAL_MS,
      maxAccuracyMeters:
        stored.liveTracking?.maxAccuracyMeters != null
          ? Number(stored.liveTracking.maxAccuracyMeters)
          : DEFAULT_MAX_ACCURACY_METERS
    }
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
    liveTracking: {
      heartbeatIntervalMs:
        input.liveTracking?.heartbeatIntervalMs ??
        prev.liveTracking?.heartbeatIntervalMs ??
        DEFAULT_HEARTBEAT_INTERVAL_MS,
      maxAccuracyMeters:
        input.liveTracking?.maxAccuracyMeters ??
        prev.liveTracking?.maxAccuracyMeters ??
        DEFAULT_MAX_ACCURACY_METERS
    }
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
  buildGeoPlatformPatch,
  syncLegacyFlagsToGeoPlatform,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_ACCURACY_METERS
};
