const Joi = require('joi');
const { GEO_FEATURE_KEYS } = require('../config/geoFeatureRegistry');

const featureFlagsSchema = GEO_FEATURE_KEYS.reduce((acc, key) => {
  acc[key] = Joi.boolean();
  return acc;
}, {});

const geoPlatformSchema = Joi.object({
  enabled: Joi.boolean(),
  defaults: Joi.object({
    mapCenter: Joi.object({
      lat: Joi.number().min(-90).max(90),
      lng: Joi.number().min(-180).max(180)
    }).allow(null),
    mapZoom: Joi.number().integer().min(1).max(21),
    countryCode: Joi.string().trim().max(8)
  }),
  features: Joi.object(featureFlagsSchema),
  limits: Joi.object({
    maxGoogleCallsPerDay: Joi.number().integer().min(1).allow(null)
  }),
  liveTracking: Joi.object({
    heartbeatIntervalMs: Joi.number().integer().min(60000).max(3600000),
    maxAccuracyMeters: Joi.number().min(10).max(500)
  })
});

const dayRouteQuerySchema = Joi.object({
  employeeId: Joi.string().hex().length(24),
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
});

const replayQuerySchema = Joi.object({
  userId: Joi.string().hex().length(24).required(),
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
});

const doctorsMapQuerySchema = Joi.object({
  territoryId: Joi.string().hex().length(24),
  locationStatus: Joi.string().valid('UNVERIFIED', 'SUGGESTED', 'VERIFIED'),
  limit: Joi.number().integer().min(1).max(2000)
});

const geocodeBodySchema = Joi.object({
  address: Joi.string().trim().min(1).max(500).required()
});

const reverseGeocodeBodySchema = Joi.object({
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required()
});

const placesAutocompleteQuerySchema = Joi.object({
  input: Joi.string().trim().min(1).max(200).required(),
  sessionToken: Joi.string().trim().max(128)
});

const optimizeRouteBodySchema = Joi.object({
  weeklyPlanId: Joi.string().hex().length(24).required(),
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  startLat: Joi.number().min(-90).max(90),
  startLng: Joi.number().min(-180).max(180)
});

const weeklyRouteQuerySchema = Joi.object({
  weeklyPlanId: Joi.string().hex().length(24).required(),
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
});

const attendanceZonesQuerySchema = Joi.object({
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  attendanceLocationStatus: Joi.string().valid('WITHIN_ZONE', 'OUT_OF_ZONE')
});

const heatMapQuerySchema = Joi.object({
  from: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  to: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  metric: Joi.string().valid('visits', 'coverage', 'travel')
});

const analyticsQuerySchema = Joi.object({
  from: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  to: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  userId: Joi.string().hex().length(24),
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
});

const territoryBoundaryBodySchema = Joi.object({
  territoryId: Joi.string().hex().length(24).required(),
  label: Joi.string().trim().max(200).allow(''),
  geometry: Joi.object({
    type: Joi.string().valid('Polygon', 'MultiPolygon').required(),
    coordinates: Joi.array().required()
  }).required()
});

const navigationQuerySchema = Joi.object({
  originLat: Joi.number().required(),
  originLng: Joi.number().required(),
  destLat: Joi.number().required(),
  destLng: Joi.number().required()
});

const distanceEtaBodySchema = Joi.object({
  origins: Joi.array()
    .items(Joi.object({ lat: Joi.number().required(), lng: Joi.number().required() }))
    .min(1)
    .required(),
  destinations: Joi.array()
    .items(Joi.object({ lat: Joi.number().required(), lng: Joi.number().required() }))
    .min(1)
    .required()
});

module.exports = {
  geoPlatformSchema,
  dayRouteQuerySchema,
  replayQuerySchema,
  doctorsMapQuerySchema,
  geocodeBodySchema,
  reverseGeocodeBodySchema,
  placesAutocompleteQuerySchema,
  optimizeRouteBodySchema,
  weeklyRouteQuerySchema,
  attendanceZonesQuerySchema,
  heatMapQuerySchema,
  analyticsQuerySchema,
  territoryBoundaryBodySchema,
  navigationQuerySchema,
  distanceEtaBodySchema
};
