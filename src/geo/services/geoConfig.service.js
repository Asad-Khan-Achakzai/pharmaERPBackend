const env = require('../../config/env');
const { resolveGeoPlatform } = require('../utils/geoPlatformResolver');
const { GEO_FEATURE_KEYS, GEO_FEATURE_LABELS, GEO_FEATURE_DESCRIPTIONS, GEO_FEATURE_PLATFORMS, GEO_FEATURE_DEPENDENCIES } = require('../config/geoFeatureRegistry');

function getPublicGeoConfig(company) {
  const geo = resolveGeoPlatform(company);
  return {
    enabled: geo.enabled,
    configVersion: geo.configVersion,
    defaults: geo.defaults,
    features: geo.features,
    limits: geo.limits,
    liveTracking: geo.liveTracking,
    maps: {
      webApiKey: env.GOOGLE_MAPS_WEB_API_KEY || '',
      androidApiKey: env.GOOGLE_MAPS_ANDROID_API_KEY || '',
      iosApiKey: env.GOOGLE_MAPS_IOS_API_KEY || ''
    }
  };
}

function getFeatureCatalog() {
  return GEO_FEATURE_KEYS.map((key) => ({
    key,
    label: GEO_FEATURE_LABELS[key],
    description: GEO_FEATURE_DESCRIPTIONS[key],
    platform: GEO_FEATURE_PLATFORMS[key],
    dependencies: GEO_FEATURE_DEPENDENCIES[key]?.requires || []
  }));
}

module.exports = { getPublicGeoConfig, getFeatureCatalog };
