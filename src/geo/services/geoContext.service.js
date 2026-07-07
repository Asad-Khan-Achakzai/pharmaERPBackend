const mongoose = require('mongoose');
const Doctor = require('../../models/Doctor');
const Pharmacy = require('../../models/Pharmacy');
const CallPoint = require('../../models/CallPoint');
const TerritoryBoundary = require('../models/TerritoryBoundary');
const RepLocationSnapshot = require('../models/RepLocationSnapshot');
const Attendance = require('../../models/Attendance');
const AttendanceHeartbeat = require('../../models/AttendanceHeartbeat');
const dayRouteService = require('./dayRoute.service');
const geoExtendedService = require('./geoExtended.service');
const businessTime = require('../../utils/businessTime');
const { resolveGeoPlatform, resolveGeofenceConfig } = require('../utils/geoPlatformResolver');
const { distanceMeters: visitDistanceMeters } = require('../../services/geoFence.service');
const {
  parseBbox,
  bboxFromCenter,
  mergeBboxes,
  latLngBoxFilter,
  haversineMeters,
  bboxPolygon
} = require('../utils/spatialQuery');
const ApiError = require('../../utils/ApiError');

const nd = { isDeleted: { $ne: true } };
const MAX_ASSETS = 200;

const DOCTOR_SELECT =
  'name specialization address city locationName latitude longitude locationStatus territoryId isActive';
const PHARMACY_SELECT = 'name address city latitude longitude territoryId isActive';
const CP_SELECT = 'name latitude longitude isActive';

function parseLayers(raw) {
  const all = ['doctors', 'pharmacies', 'callPoints', 'territories', 'geofences', 'heatmap', 'route'];
  if (raw === '' || raw === 'none') return new Set();
  if (!raw) return new Set(all);
  const set = new Set(
    String(raw)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  return set.size ? set : new Set(all);
}

async function resolveEmployeeLocation(companyId, employeeId) {
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const uid = new mongoose.Types.ObjectId(String(employeeId));
  const snapshot = await RepLocationSnapshot.findOne({ companyId: cid, userId: uid })
    .select('lat lng capturedAt')
    .lean();
  if (snapshot?.lat != null && snapshot?.lng != null) {
    return { lat: snapshot.lat, lng: snapshot.lng, source: 'snapshot' };
  }
  const hb = await AttendanceHeartbeat.findOne({ companyId: cid, userId: uid })
    .sort({ capturedAt: -1 })
    .select('lat lng capturedAt')
    .lean();
  if (hb?.lat != null && hb?.lng != null) {
    return { lat: hb.lat, lng: hb.lng, source: 'heartbeat' };
  }
  return null;
}

async function loadDoctorsInBbox(companyId, bbox, limit = MAX_ASSETS) {
  const rows = await Doctor.find({
    companyId,
    isActive: true,
    ...nd,
    ...latLngBoxFilter(bbox)
  })
    .select(DOCTOR_SELECT)
    .limit(limit)
    .lean();
  return rows
    .filter((d) => typeof d.latitude === 'number' && typeof d.longitude === 'number')
    .map((d) => ({
      id: String(d._id),
      name: d.name,
      specialization: d.specialization || null,
      address: d.address || d.locationName || null,
      city: d.city || null,
      lat: d.latitude,
      lng: d.longitude,
      locationStatus: d.locationStatus,
      territoryId: d.territoryId ? String(d.territoryId) : null
    }));
}

async function loadPharmaciesInBbox(companyId, bbox, limit = MAX_ASSETS) {
  const rows = await Pharmacy.find({
    companyId,
    isActive: true,
    ...nd,
    ...latLngBoxFilter(bbox)
  })
    .select(PHARMACY_SELECT)
    .limit(limit)
    .lean();
  return rows
    .filter((p) => typeof p.latitude === 'number' && typeof p.longitude === 'number')
    .map((p) => ({
      id: String(p._id),
      name: p.name,
      address: p.address || null,
      city: p.city || null,
      lat: p.latitude,
      lng: p.longitude,
      territoryId: p.territoryId ? String(p.territoryId) : null
    }));
}

async function loadCallPointsInBbox(companyId, bbox, limit = MAX_ASSETS) {
  const rows = await CallPoint.find({
    companyId,
    isActive: true,
    ...nd,
    latitude: { $gte: bbox.south, $lte: bbox.north },
    longitude: { $gte: bbox.west, $lte: bbox.east }
  })
    .select(CP_SELECT)
    .limit(limit)
    .lean();
  return rows.map((cp) => ({
    id: String(cp._id),
    name: cp.name,
    lat: cp.latitude,
    lng: cp.longitude
  }));
}

async function loadTerritoriesInBbox(companyId, bbox) {
  const rows = await TerritoryBoundary.find({
    companyId,
    isActive: { $ne: false },
    geometry: {
      $geoIntersects: {
        $geometry: bboxPolygon(bbox)
      }
    }
  })
    .select('territoryId geometry label')
    .limit(50)
    .lean();
  return rows.map((t) => ({
    id: String(t._id),
    territoryId: String(t.territoryId),
    label: t.label || '',
    geometry: t.geometry
  }));
}

function attachDistance(items, origin) {
  if (!origin) return items;
  return items.map((item) => ({
    ...item,
    distanceMeters: Math.round(haversineMeters(origin.lat, origin.lng, item.lat, item.lng))
  }));
}

function pickActiveAndPlannedVisit(dayRoute, trackingContext) {
  const items = dayRoute?.items || [];
  const pending = items.filter((i) => i.status === 'PENDING' && i.doctor?.lat != null);
  const plannedVisit = pending[0]
    ? {
        planItemId: String(pending[0].planItemId),
        status: pending[0].status,
        doctor: pending[0].doctor
      }
    : null;

  let activeVisit = null;
  const ctx = String(trackingContext || '').toUpperCase();
  if (ctx.includes('ACTIVE_VISIT') || ctx.includes('AT_DOCTOR')) {
    const target = plannedVisit || items.find((i) => i.doctor?.lat != null);
    if (target?.doctor) {
      activeVisit = {
        planItemId: String(target.planItemId),
        status: 'IN_PROGRESS',
        doctor: target.doctor,
        inferredFrom: trackingContext || 'route'
      };
    }
  }
  return { activeVisit, plannedVisit, routeItems: items };
}

async function buildGeofenceLayer(company, employeeLocation, employeeContext) {
  const cfg = resolveGeofenceConfig(company);
  if (!cfg.featureEnabled) return [];

  const circles = [];
  const radius = cfg.radiusMeters;
  const doctor =
    employeeContext?.activeVisit?.doctor || employeeContext?.plannedVisit?.doctor || null;
  if (doctor?.lat != null && doctor?.lng != null) {
    let status = 'UNKNOWN';
    if (employeeLocation) {
      const dist = visitDistanceMeters(doctor.lat, doctor.lng, employeeLocation.lat, employeeLocation.lng);
      status = dist != null && dist <= radius ? 'INSIDE_RADIUS' : 'OUTSIDE_RADIUS';
    }
    circles.push({
      type: 'visit_radius',
      doctorId: String(doctor.id || doctor._id || ''),
      lat: doctor.lat,
      lng: doctor.lng,
      radiusMeters: radius,
      mode: cfg.mode,
      status
    });
  }
  return circles;
}

async function estimateTravelMeters(companyId, employeeId, timeZone) {
  try {
    const tz = businessTime.requireCompanyIanaZone(timeZone);
    const ymd = businessTime.nowInBusinessTime(tz).toISODate();
    const travel = await geoExtendedService.getTravelAnalytics(
      companyId,
      { userId: String(employeeId), date: ymd },
      timeZone
    );
    return travel?.estimatedDistanceMeters ?? null;
  } catch {
    return null;
  }
}

async function getMapContext(companyId, company, query, timeZone) {
  const geo = resolveGeoPlatform(company);
  const layers = parseLayers(query.layers);
  const radiusMeters = Math.max(50, Math.min(Number(query.radiusMeters) || 250, 5000));

  let bbox = parseBbox(query.bbox) || parseBbox(query);
  if (!bbox && query.north != null) {
    bbox = parseBbox({
      north: query.north,
      south: query.south,
      east: query.east,
      west: query.west
    });
  }
  if (!bbox) {
    throw new ApiError(400, 'bbox is required (west,south,east,north or north/south/east/west params)');
  }

  const areaKm2 = Math.abs(bbox.north - bbox.south) * Math.abs(bbox.east - bbox.west) * 12321;
  if (areaKm2 > 25000) {
    throw new ApiError(400, 'Map viewport is too large — zoom in to load contextual assets');
  }

  let employeeLocation = null;
  let employeeContext = null;

  if (query.employeeId) {
    employeeLocation = await resolveEmployeeLocation(companyId, query.employeeId);
    const proximityBox = employeeLocation ? bboxFromCenter(employeeLocation.lat, employeeLocation.lng, radiusMeters) : null;
    bbox = mergeBboxes(bbox, proximityBox);

    if (layers.has('route') || query.employeeId) {
      const dayRoute = await dayRouteService.getDayRoute(
        companyId,
        query.employeeId,
        query.date,
        timeZone
      );
      const trackingContext = query.trackingContext || null;
      const { activeVisit, plannedVisit, routeItems } = pickActiveAndPlannedVisit(dayRoute, trackingContext);
      const distanceTravelledMeters = await estimateTravelMeters(companyId, query.employeeId, timeZone);
      employeeContext = {
        userId: String(query.employeeId),
        location: employeeLocation,
        activeVisit,
        plannedVisit,
        todayRoute: routeItems,
        distanceTravelledMeters,
        trackingContext: trackingContext || null
      };
    }
  }

  const tasks = [];
  const result = {
    bbox,
    radiusMeters,
    doctors: [],
    pharmacies: [],
    callPoints: [],
    territories: [],
    geofences: [],
    heatmap: null,
    employee: employeeContext,
    counts: { doctors: 0, pharmacies: 0, callPoints: 0 }
  };

  if (layers.has('doctors') && geo.features.doctorMaps) {
    tasks.push(
      loadDoctorsInBbox(companyId, bbox).then((rows) => {
        result.doctors = attachDistance(rows, employeeLocation);
        result.counts.doctors = rows.length;
      })
    );
  }

  if (layers.has('pharmacies') && geo.features.pharmacyMaps) {
    tasks.push(
      loadPharmaciesInBbox(companyId, bbox).then((rows) => {
        result.pharmacies = attachDistance(rows, employeeLocation);
        result.counts.pharmacies = rows.length;
      })
    );
  }

  if (layers.has('callPoints') && geo.features.callPointMaps) {
    tasks.push(
      loadCallPointsInBbox(companyId, bbox).then((rows) => {
        result.callPoints = attachDistance(rows, employeeLocation);
        result.counts.callPoints = rows.length;
      })
    );
  }

  if (layers.has('territories') && geo.features.territoryPolygons) {
    tasks.push(
      loadTerritoriesInBbox(companyId, bbox).then((rows) => {
        result.territories = rows;
      })
    );
  }

  if (layers.has('geofences') && geo.features.geofencing) {
    tasks.push(
      buildGeofenceLayer(company, employeeLocation, employeeContext).then((rows) => {
        result.geofences = rows;
      })
    );
  }

  if (layers.has('heatmap') && geo.features.heatMaps) {
    tasks.push(
      geoExtendedService
        .getHeatMap(companyId, { from: query.date, to: query.date }, timeZone)
        .then((hm) => {
          const pts = (hm?.points || []).filter(
            (p) =>
              p.lat >= bbox.south &&
              p.lat <= bbox.north &&
              p.lng >= bbox.west &&
              p.lng <= bbox.east
          );
          result.heatmap = { points: pts.slice(0, MAX_ASSETS), metric: hm?.metric || 'visits' };
        })
        .catch(() => {
          result.heatmap = { points: [], metric: 'visits' };
        })
    );
  }

  await Promise.all(tasks);

  if (employeeLocation && employeeContext) {
    const nearbyDoctors = result.doctors.filter((d) => (d.distanceMeters ?? Infinity) <= radiusMeters);
    const nearbyPharmacies = result.pharmacies.filter((p) => (p.distanceMeters ?? Infinity) <= radiusMeters);
    const nearbyCps = result.callPoints.filter((c) => (c.distanceMeters ?? Infinity) <= radiusMeters);
    employeeContext.nearbyCounts = {
      doctors: nearbyDoctors.length,
      pharmacies: nearbyPharmacies.length,
      callPoints: nearbyCps.length
    };
  }

  return result;
}

module.exports = { getMapContext, loadDoctorsInBbox, loadPharmaciesInBbox };
