const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGeofenceConfig, resolveGeoPlatform } = require('./geoPlatformResolver');
const { GEO_FENCE_MODE } = require('../../constants/enums');

test('resolveGeofenceConfig uses geoPlatform.features.geofencing', () => {
  const company = {
    geoPlatform: {
      enabled: true,
      features: { geofencing: true }
    },
    geoFenceMode: GEO_FENCE_MODE.STRICT,
    geoFenceRadiusMeters: 200
  };
  const cfg = resolveGeofenceConfig(company);
  assert.equal(cfg.featureEnabled, true);
  assert.equal(cfg.active, true);
  assert.equal(cfg.radiusMeters, 200);
});

test('resolveGeoPlatform inherits pharmacyMaps from doctorMaps when unset', () => {
  const company = {
    geoPlatform: {
      enabled: true,
      features: { doctorMaps: true }
    }
  };
  const geo = resolveGeoPlatform(company);
  assert.equal(geo.features.pharmacyMaps, true);
});
