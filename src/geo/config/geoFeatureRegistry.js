/**
 * Canonical Geo Platform feature keys and dependency graph.
 */

const GEO_FEATURE_KEYS = Object.freeze([
  'liveTracking',
  'managerLiveMap',
  'doctorMaps',
  'pharmacyMaps',
  'doctorLocationReviewMaps',
  'callPointMaps',
  'attendanceMaps',
  'weeklyPlanMaps',
  'dailyPlanMaps',
  'activeVisitMaps',
  'navigation',
  'routeOptimization',
  'routeReplay',
  'heatMaps',
  'territoryPolygons',
  'geofencing',
  'placesAutocomplete',
  'geocoding',
  'distanceAndEta',
  'routeAnalytics',
  'travelAnalytics',
  'aiGeoApis'
]);

const GEO_FEATURE_DEPENDENCIES = Object.freeze({
  managerLiveMap: { requires: ['liveTracking'] },
  routeOptimization: { requires: ['dailyPlanMaps'] },
  navigation: { requires: ['activeVisitMaps'] },
  distanceAndEta: { requires: ['dailyPlanMaps'] },
  routeReplay: { requires: ['liveTracking'] },
  routeAnalytics: { requires: ['liveTracking', 'dailyPlanMaps'] },
  travelAnalytics: { requires: ['liveTracking', 'routeReplay'] },
  heatMaps: { requires: ['doctorMaps'] },
  aiGeoApis: { requires: [] }
});

const GEO_FEATURE_LABELS = Object.freeze({
  liveTracking: 'Rep location sharing (GPS while checked in on mobile)',
  managerLiveMap: 'Manager live map (view reps on web & mobile)',
  doctorMaps: 'Doctor maps',
  pharmacyMaps: 'Pharmacy maps',
  doctorLocationReviewMaps: 'Doctor location review maps',
  callPointMaps: 'Call point maps',
  attendanceMaps: 'Attendance zone maps',
  weeklyPlanMaps: 'Weekly plan route maps',
  dailyPlanMaps: 'Daily plan route maps',
  activeVisitMaps: 'Active visit maps',
  navigation: 'In-app navigation',
  routeOptimization: 'Route optimization',
  routeReplay: 'Route replay',
  heatMaps: 'Heat maps',
  territoryPolygons: 'Territory polygons',
  geofencing: 'Geofencing',
  placesAutocomplete: 'Places autocomplete',
  geocoding: 'Geocoding',
  distanceAndEta: 'Distance & ETA',
  routeAnalytics: 'Route analytics',
  travelAnalytics: 'Travel analytics',
  aiGeoApis: 'AI-ready geo APIs'
});

const GEO_FEATURE_DESCRIPTIONS = Object.freeze({
  liveTracking:
    'When enabled, checked-in field reps on mobile send periodic GPS heartbeats while on duty. When disabled, no live location is collected during attendance.',
  managerLiveMap:
    'When enabled, managers can view real-time rep locations on the live map (web Team Live page and mobile manager Live screen). Enabling this also requires rep location sharing. When disabled, live map screens and APIs are hidden.',
  doctorMaps:
    'When enabled, doctor list and detail screens show map pins for doctors with coordinates (web and mobile). When disabled, map views are hidden.',
  pharmacyMaps:
    'When enabled, pharmacy list and detail screens show map pins and location picker for pharmacies with coordinates (web). When disabled, pharmacy map views are hidden.',
  doctorLocationReviewMaps:
    'When enabled, admins and managers can review and correct doctor GPS coordinates on the location review map (web). When disabled, that page and API are unavailable.',
  callPointMaps:
    'When enabled, the call points module shows a geographic map of coverage points (web). When disabled, the map view is hidden.',
  attendanceMaps:
    'When enabled, team attendance views show check-in zone maps for reviewing where reps checked in (web). When disabled, zone maps are hidden.',
  weeklyPlanMaps:
    'When enabled, weekly plan detail shows the planned visit route on a map (web). When disabled, the weekly route map is hidden.',
  dailyPlanMaps:
    'When enabled, today\'s visits show the daily route map (web and mobile). When disabled, the daily route map is hidden.',
  activeVisitMaps:
    'When enabled, the active visit screen shows a map with the visit location during a call (mobile). When disabled, the visit map is hidden.',
  navigation:
    'When enabled, reps can launch turn-by-turn navigation to the next visit from the mobile app. When disabled, in-app navigation actions are hidden.',
  routeOptimization:
    'When enabled, the backend can reorder daily visit stops for a shorter driving route (web and mobile clients that request optimization). When disabled, the optimization API is blocked.',
  routeReplay:
    'When enabled, managers can replay historical rep GPS trails for a selected day. When disabled, route replay APIs and UI are unavailable.',
  heatMaps:
    'When enabled, doctor visit density heat maps are available in geo analytics (web). When disabled, heat map APIs are blocked.',
  territoryPolygons:
    'When enabled, territory boundaries render on maps and territory polygon APIs are available (web and mobile). When disabled, polygon overlays are hidden.',
  geofencing:
    'When enabled, check-in and check-out can enforce proximity to allowed zones per company policy (web configuration, mobile enforcement). When disabled, geofence validation is skipped.',
  placesAutocomplete:
    'When enabled, address search with Google Places autocomplete is available when picking locations (web and mobile). When disabled, autocomplete API calls are blocked.',
  geocoding:
    'When enabled, addresses can be converted to and from coordinates via the geocoding API (web and mobile). When disabled, geocode endpoints are blocked.',
  distanceAndEta:
    'When enabled, drive distance and ETA calculations between stops are available (web and mobile). When disabled, the distance-eta API is blocked.',
  routeAnalytics:
    'When enabled, route compliance and planning analytics appear in geo reports (web). When disabled, route analytics APIs are blocked.',
  travelAnalytics:
    'When enabled, travel time and distance summary analytics are available for managers (web). When disabled, travel analytics APIs are blocked.',
  aiGeoApis:
    'When enabled, AI-assisted geo summary endpoints are available for admins (web). When disabled, AI geo API routes return forbidden.'
});

const GEO_FEATURE_PLATFORMS = Object.freeze({
  liveTracking: 'mobile',
  managerLiveMap: 'both',
  doctorMaps: 'both',
  pharmacyMaps: 'web',
  doctorLocationReviewMaps: 'web',
  callPointMaps: 'web',
  attendanceMaps: 'web',
  weeklyPlanMaps: 'web',
  dailyPlanMaps: 'both',
  activeVisitMaps: 'mobile',
  navigation: 'mobile',
  routeOptimization: 'both',
  routeReplay: 'both',
  heatMaps: 'web',
  territoryPolygons: 'both',
  geofencing: 'both',
  placesAutocomplete: 'both',
  geocoding: 'both',
  distanceAndEta: 'both',
  routeAnalytics: 'web',
  travelAnalytics: 'web',
  aiGeoApis: 'web'
});

function defaultFeaturesObject() {
  return GEO_FEATURE_KEYS.reduce((acc, key) => {
    acc[key] = false;
    return acc;
  }, {});
}

module.exports = {
  GEO_FEATURE_KEYS,
  GEO_FEATURE_DEPENDENCIES,
  GEO_FEATURE_LABELS,
  GEO_FEATURE_DESCRIPTIONS,
  GEO_FEATURE_PLATFORMS,
  defaultFeaturesObject
};
