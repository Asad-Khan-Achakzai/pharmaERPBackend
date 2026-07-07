const express = require('express');
const router = express.Router();
const c = require('../controllers/geo.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { attachGeoPlatform, requireGeoFeature } = require('../middleware/requireGeoFeature');
const { validate, validateQuery } = require('../../middleware/validate');
const { checkPermission, checkPermissionAny } = require('../../middleware/checkPermission');
const {
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
  distanceEtaBodySchema,
  mapContextQuerySchema
} = require('../validators/geo.validator');

router.use(authenticate, companyScope, attachGeoPlatform);

router.get('/config', c.config);
router.get('/features/catalog', c.featureCatalog);

router.get(
  '/live',
  requireGeoFeature('managerLiveMap'),
  checkPermissionAny('team.view', 'team.viewAllReports', 'attendance.viewTeam', 'admin.access'),
  c.live
);

router.get(
  '/context',
  requireGeoFeature('managerLiveMap'),
  checkPermissionAny('team.view', 'team.viewAllReports', 'attendance.viewTeam', 'admin.access'),
  validateQuery(mapContextQuerySchema),
  c.mapContext
);

router.get('/day-route', requireGeoFeature('dailyPlanMaps'), validateQuery(dayRouteQuerySchema), c.dayRoute);
router.get(
  '/weekly-route',
  requireGeoFeature('weeklyPlanMaps'),
  validateQuery(weeklyRouteQuerySchema),
  c.weeklyRoute
);

router.get(
  '/doctors',
  requireGeoFeature('doctorMaps'),
  validateQuery(doctorsMapQuerySchema),
  c.doctorsMap
);

router.get('/call-points', requireGeoFeature('callPointMaps'), c.callPointsMap);

router.get(
  '/visit-context/:planItemId',
  requireGeoFeature('activeVisitMaps'),
  c.visitContext
);

router.get('/replay', requireGeoFeature('routeReplay'), validateQuery(replayQuerySchema), c.replay);

router.get(
  '/attendance-zones',
  requireGeoFeature('attendanceMaps'),
  checkPermissionAny('attendance.viewTeam', 'attendance.viewCompany', 'admin.access'),
  validateQuery(attendanceZonesQuerySchema),
  c.attendanceZones
);

router.get('/heatmaps', requireGeoFeature('heatMaps'), validateQuery(heatMapQuerySchema), c.heatMap);

router.post(
  '/optimize-route',
  requireGeoFeature('routeOptimization'),
  checkPermission('weeklyPlans.edit'),
  validate(optimizeRouteBodySchema),
  c.optimizeRoute
);

router.get(
  '/territory-boundaries',
  requireGeoFeature('territoryPolygons'),
  c.territoryBoundaries
);
router.post(
  '/territory-boundaries',
  requireGeoFeature('territoryPolygons'),
  checkPermission('admin.access'),
  validate(territoryBoundaryBodySchema),
  c.saveTerritoryBoundary
);

router.get(
  '/analytics/routes',
  requireGeoFeature('routeAnalytics'),
  checkPermissionAny('reports.view', 'admin.access'),
  validateQuery(analyticsQuerySchema),
  c.routeAnalytics
);

router.get(
  '/analytics/travel',
  requireGeoFeature('travelAnalytics'),
  checkPermissionAny('reports.view', 'admin.access'),
  validateQuery(analyticsQuerySchema),
  c.travelAnalytics
);

router.get(
  '/navigation',
  requireGeoFeature('navigation'),
  validateQuery(navigationQuerySchema),
  c.navigation
);

router.post('/distance-eta', requireGeoFeature('distanceAndEta'), validate(distanceEtaBodySchema), c.distanceEta);

router.post('/geocode', requireGeoFeature('geocoding'), validate(geocodeBodySchema), c.geocode);
router.post(
  '/reverse-geocode',
  requireGeoFeature('geocoding'),
  validate(reverseGeocodeBodySchema),
  c.reverseGeocode
);

router.get(
  '/places/autocomplete',
  requireGeoFeature('placesAutocomplete'),
  validateQuery(placesAutocompleteQuerySchema),
  c.placesAutocomplete
);

router.get('/usage', checkPermission('admin.access'), c.usage);

router.get('/ai/company-summary', requireGeoFeature('aiGeoApis'), checkPermission('admin.access'), c.aiCompanySummary);

module.exports = router;
