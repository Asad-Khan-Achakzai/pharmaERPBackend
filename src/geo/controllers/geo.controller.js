const geoConfigService = require('../services/geoConfig.service');
const geoLiveService = require('../services/geoLive.service');
const dayRouteService = require('../services/dayRoute.service');
const googleMapsGateway = require('../services/google/googleMapsGateway.service');
const usageMeteringService = require('../services/usageMetering.service');
const geoExtendedService = require('../services/geoExtended.service');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../middleware/asyncHandler');
const ApiError = require('../../utils/ApiError');
const { resolveSubtreeUserIds } = require('../../utils/teamScope');
const { userHasPermission } = require('../../utils/effectivePermissions');

const config = asyncHandler(async (req, res) => {
  const data = geoConfigService.getPublicGeoConfig(req.context.company);
  ApiResponse.success(res, data);
});

const featureCatalog = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, geoConfigService.getFeatureCatalog());
});

const live = asyncHandler(async (req, res) => {
  const result = await geoLiveService.listLive(
    req.companyId,
    req.user,
    req.context.timeZone,
    req.context.company,
    { ifNoneMatch: req.headers['if-none-match'] }
  );

  if (result.notModified) {
    res.setHeader('ETag', result.etag);
    return res.status(304).end();
  }

  res.setHeader('ETag', result.etag);
  ApiResponse.success(res, result.rows);
});

const dayRoute = asyncHandler(async (req, res) => {
  let employeeId = req.query.employeeId || req.user.userId;
  if (String(employeeId) !== String(req.user.userId)) {
    if (!userHasPermission(req.user, 'admin.access')) {
      const subtree = await resolveSubtreeUserIds(req.companyId, req.user.userId, {
        includeSelf: true,
        activeOnly: true
      });
      const ok = subtree.some((id) => String(id) === String(employeeId));
      if (!ok) throw new ApiError(403, 'You can only view routes for yourself or your team');
    }
  }
  const data = await dayRouteService.getDayRoute(
    req.companyId,
    employeeId,
    req.query.date,
    req.context.timeZone
  );
  ApiResponse.success(res, data);
});

const doctorsMap = asyncHandler(async (req, res) => {
  const data = await dayRouteService.listDoctorsForMap(req.companyId, req.query);
  ApiResponse.success(res, data);
});

const callPointsMap = asyncHandler(async (req, res) => {
  const data = await dayRouteService.listCallPointsForMap(req.companyId);
  ApiResponse.success(res, data);
});

const visitContext = asyncHandler(async (req, res) => {
  const data = await dayRouteService.getVisitContext(req.companyId, req.params.planItemId);
  ApiResponse.success(res, data);
});

const replay = asyncHandler(async (req, res) => {
  const targetUserId = req.query.userId || req.user.userId;
  if (String(targetUserId) !== String(req.user.userId)) {
    if (!userHasPermission(req.user, 'admin.access')) {
      const subtree = await resolveSubtreeUserIds(req.companyId, req.user.userId, {
        includeSelf: true,
        activeOnly: true
      });
      const ok = subtree.some((id) => String(id) === String(targetUserId));
      if (!ok) throw new ApiError(403, 'You can only replay routes for yourself or your team');
    }
  }
  const data = await dayRouteService.getRouteReplay(
    req.companyId,
    targetUserId,
    req.query.date,
    req.context.timeZone
  );
  ApiResponse.success(res, data);
});

const geocode = asyncHandler(async (req, res) => {
  const data = await googleMapsGateway.geocode({
    companyId: req.companyId,
    company: req.context.company,
    userId: req.user.userId,
    address: req.body.address
  });
  ApiResponse.success(res, data);
});

const reverseGeocode = asyncHandler(async (req, res) => {
  const data = await googleMapsGateway.reverseGeocode({
    companyId: req.companyId,
    company: req.context.company,
    userId: req.user.userId,
    lat: req.body.lat,
    lng: req.body.lng
  });
  ApiResponse.success(res, data);
});

const placesAutocomplete = asyncHandler(async (req, res) => {
  const data = await googleMapsGateway.placesAutocomplete({
    companyId: req.companyId,
    company: req.context.company,
    userId: req.user.userId,
    input: req.query.input,
    sessionToken: req.query.sessionToken
  });
  ApiResponse.success(res, data);
});

const usage = asyncHandler(async (req, res) => {
  const data = await usageMeteringService.getUsageSummary(req.companyId, req.query);
  ApiResponse.success(res, data);
});

/** AI-ready structured export — minimal v1 */
const aiCompanySummary = asyncHandler(async (req, res) => {
  const geo = geoConfigService.getPublicGeoConfig(req.context.company);
  const doctors = await dayRouteService.listDoctorsForMap(req.companyId, { limit: 5000 });
  ApiResponse.success(res, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    companyId: String(req.companyId),
    geoPlatformEnabled: geo.enabled,
    enabledFeatures: Object.entries(geo.features)
      .filter(([, v]) => v)
      .map(([k]) => k),
    doctorPinsCount: doctors.length
  });
});

const weeklyRoute = asyncHandler(async (req, res) => {
  const data = await geoExtendedService.getWeeklyRoute(
    req.companyId,
    req.query.weeklyPlanId,
    req.query.date,
    req.context.timeZone
  );
  ApiResponse.success(res, data);
});

const attendanceZones = asyncHandler(async (req, res) => {
  const data = await geoExtendedService.getAttendanceZones(req.companyId, req.query, req.context.timeZone);
  ApiResponse.success(res, data);
});

const heatMap = asyncHandler(async (req, res) => {
  const data = await geoExtendedService.getHeatMap(req.companyId, req.query, req.context.timeZone);
  ApiResponse.success(res, data);
});

const optimizeRoute = asyncHandler(async (req, res) => {
  const data = await geoExtendedService.optimizeRoute(
    req.companyId,
    req.body,
    req.user,
    req.context.timeZone
  );
  ApiResponse.success(res, data, 'Route optimized');
});

const territoryBoundaries = asyncHandler(async (req, res) => {
  const data = await geoExtendedService.listTerritoryBoundaries(req.companyId, req.query);
  ApiResponse.success(res, data);
});

const saveTerritoryBoundary = asyncHandler(async (req, res) => {
  const data = await geoExtendedService.upsertTerritoryBoundary(req.companyId, req.body);
  ApiResponse.success(res, data, 'Territory boundary saved');
});

const routeAnalytics = asyncHandler(async (req, res) => {
  const data = await geoExtendedService.getRouteAnalytics(req.companyId, req.query, req.context.timeZone);
  ApiResponse.success(res, data);
});

const travelAnalytics = asyncHandler(async (req, res) => {
  const data = await geoExtendedService.getTravelAnalytics(req.companyId, req.query, req.context.timeZone);
  ApiResponse.success(res, data);
});

const navigation = asyncHandler(async (req, res) => {
  const data = await googleMapsGateway.computeRoute({
    companyId: req.companyId,
    company: req.context.company,
    userId: req.user.userId,
    waypoints: [
      { lat: Number(req.query.originLat), lng: Number(req.query.originLng) },
      { lat: Number(req.query.destLat), lng: Number(req.query.destLng) }
    ]
  });
  ApiResponse.success(res, data);
});

const distanceEta = asyncHandler(async (req, res) => {
  const data = await googleMapsGateway.distanceMatrix({
    companyId: req.companyId,
    company: req.context.company,
    userId: req.user.userId,
    origins: req.body.origins,
    destinations: req.body.destinations
  });
  ApiResponse.success(res, data);
});

module.exports = {
  config,
  featureCatalog,
  live,
  dayRoute,
  doctorsMap,
  callPointsMap,
  visitContext,
  replay,
  geocode,
  reverseGeocode,
  placesAutocomplete,
  usage,
  aiCompanySummary,
  weeklyRoute,
  attendanceZones,
  heatMap,
  optimizeRoute,
  territoryBoundaries,
  saveTerritoryBoundary,
  routeAnalytics,
  travelAnalytics,
  navigation,
  distanceEta
};
