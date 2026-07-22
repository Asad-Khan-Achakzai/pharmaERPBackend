const mongoose = require('mongoose');
const { Info } = require('luxon');
const { ATTENDANCE_SYSTEM_MODE } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const checkInPolicySchema = new mongoose.Schema(
  {
    type: { type: String, default: 'COMPANY_DEFAULT' },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    radiusMeters: { type: Number, default: 150, min: 25, max: 5000 },
    locationName: { type: String, trim: true, maxlength: 200, default: '' }
  },
  { _id: false }
);

/**
 * Per-company temporary-file retention (days). null = never delete (permanent).
 * Defaults are null so enabling media uploads can never delete anything until an
 * admin explicitly opts in to a retention window. Max 3650 (~10y) as a guard.
 */
const mediaRetentionSchema = new mongoose.Schema(
  {
    checkinRetentionDays: { type: Number, default: null, min: 1, max: 3650 },
    visitRetentionDays: { type: Number, default: null, min: 1, max: 3650 },
    expenseReceiptRetentionDays: { type: Number, default: null, min: 1, max: 3650 }
  },
  { _id: false }
);

const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, default: 'Pakistan' },
    /** Legacy single phone — kept in sync with phones[0] for older consumers. */
    phone: { type: String, trim: true },
    /** One or more company contact numbers (printed on invoices). */
    phones: { type: [String], default: undefined },
    /** Pakistan FBR National Tax Number — printed on delivery invoices. */
    ntnNo: { type: String, trim: true, maxlength: 64 },
    email: { type: String, trim: true, lowercase: true },
    /** Public path or URL for company logo (e.g. /company-logos/<id>.png). */
    logo: { type: String },
    /**
     * Raw base64 (no data: prefix) so invoices still render when the disk file is
     * missing (ephemeral hosts, other machines). Omitted from default queries.
     */
    logoBase64: { type: String, select: false },
    logoMime: { type: String, select: false },
    currency: { type: String, default: 'PKR' },
    /**
     * Unit-price label basis on delivery invoices.
     * TRADE → "TP. RATE", NET → "NP. RATE". Default TRADE preserves existing invoices.
     */
    invoicePriceMode: {
      type: String,
      enum: ['TRADE', 'NET'],
      default: 'TRADE'
    },
    /** Starting bank/cash position for implied cash balance (collections + settlements − outflows) */
    cashOpeningBalance: { type: Number, default: 0 },
    /**
     * Per-tenant feature flag (Phase 2B). When true, weekly plans require manager approval
     * before they go ACTIVE. New plans inherit this flag at creation; flipping it later
     * affects only future plans.
     */
    weeklyPlanApprovalRequired: { type: Boolean, default: false },
    /**
     * When true, reps cannot mark a visit out of planned sequence (same effect as env STRICT_VISIT_SEQUENCE=1).
     */
    strictVisitSequence: { type: Boolean, default: false },
    /**
     * When true, users may set `coverageTerritoryIds` (additional Zone/Area/Brick nodes).
     * `territoryId` remains the primary node; ownership queries union primary + extras.
     */
    mrepMultiTerritory: { type: Boolean, default: false },
    /** When true, doctor assignment changes append `DoctorOwnershipEvent` rows (additive audit). */
    mrepOwnershipAudit: { type: Boolean, default: false },
    /**
     * Attendance governance (all default false — production-safe; enable per company).
     * When false, behaviour matches legacy check-in/out with additive audit fields only.
     */
    attendanceGovernanceEnabled: { type: Boolean, default: false },
    /** When true, WorkShift / policy assignment affects late detection and /me/today hints. */
    attendancePoliciesEnabled: { type: Boolean, default: false },
    /** When true, AttendanceRequest workflow + inbox APIs are active. */
    attendanceApprovalsEnabled: { type: Boolean, default: false },
    /** When true, check-in after grace + late blocks until overridden (requires policies). */
    strictLateBlocking: { type: Boolean, default: false },
    /**
     * When true with strictLateBlocking + policies + late check-in, employee check-in still records (lateMinutes kept).
     * Default false preserves legacy hard-block for tenants that already enabled strict mode.
     */
    allowCheckInWhenLate: { type: Boolean, default: false },
    /**
     * When true with attendanceApprovalsEnabled + lateMinutes on check-in, submit a linked LATE_ARRIVAL workflow (non-blocking).
     */
    autoRequestOnLateCheckIn: { type: Boolean, default: false },
    /** Onboarding controls (enterprise rollout) */
    onboardingEnabled: { type: Boolean, default: false },
    onboardingStrictValidation: { type: Boolean, default: false },
    onboardingKillSwitch: { type: Boolean, default: false },
    onboardingPilotCohort: { type: String, trim: true, maxlength: 64, default: '' },
    /**
     * Attendance request automation (all optional; defaults preserve legacy behaviour).
     */
    /** Hours after submission when SLA timer fires (null = no SLA-based automation). */
    attendanceApprovalSlaHours: { type: Number, default: null, min: 0.25, max: 336 },
    /** When SLA elapses: NONE (default), ESCALATE_NEXT, ADMIN_POOL */
    attendanceSlaBreachAction: {
      type: String,
      enum: ['NONE', 'ESCALATE_NEXT', 'ADMIN_POOL'],
      default: 'NONE'
    },
    /** After company-local close of the attendance workday, run attendanceEodEscalationAction once per request/day. */
    attendanceEodEscalationEnabled: { type: Boolean, default: false },
    attendanceEodEscalationAction: {
      type: String,
      enum: ['NONE', 'ESCALATE_NEXT', 'ADMIN_POOL'],
      default: 'NONE'
    },
    /** Allow managers in the requester’s reporting chain to act (approve/reject/escalate) before the step is theirs. */
    attendanceOversightInterventionEnabled: { type: Boolean, default: false },
    /**
     * Optional: auto-reject pending late-arrival requests after N hours (compliance / hygiene).
     * Null = disabled. Uses same clock as SLA.
     */
    attendancePendingAutoRejectHours: { type: Number, default: null, min: 1, max: 720 },
    /** Single canonical IANA timezone for business calendar (reports, plans, attendance anchors). Required at creation — no implicit UTC. */
    timeZone: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator(v) {
          return Info.isValidIANAZone(String(v || '').trim());
        },
        message: 'Company timeZone must be a valid IANA timezone identifier'
      }
    },
    isActive: { type: Boolean, default: true },
    /**
     * Mobile feature flags (Phase 0 additive). All default false so existing
     * companies remain unaffected until explicitly opted in.
     */
    mobileEnabled: { type: Boolean, default: true },
    mobilePushEnabled: { type: Boolean, default: false },
    /**
     * Device Control (single mobile device binding per field-force rep).
     * Default false — production-safe. When false, mobile login behaves like a
     * normal login with no device restriction. When true, each DEFAULT_MEDICAL_REP
     * is bound to one active mobile device; logins from other devices are blocked
     * pending an admin-approved device change. Web auth is NEVER affected.
     */
    deviceControlEnabled: { type: Boolean, default: false },
    attendanceGeofenceEnabled: { type: Boolean, default: false },
    doctorApprovalRequired: { type: Boolean, default: false },
    liveTrackingEnabled: { type: Boolean, default: false },
    /**
     * Visit geo-fencing for doctors with locationStatus = VERIFIED.
     * Defaults keep existing visit workflows unchanged until opted in.
     */
    geoFencingEnabled: { type: Boolean, default: false },
    geoFenceRadiusMeters: { type: Number, default: 150, min: 25, max: 5000 },
    geoFenceMode: {
      type: String,
      enum: ['OFF', 'SOFT', 'STRICT'],
      default: 'OFF'
    },
    /**
     * When true, field expenses from mobile stay PENDING until a manager approves
     * and GL is posted. Default false — existing tenants auto-post on create.
     */
    expenseApprovalRequired: { type: Boolean, default: false },
    /**
     * Attendance check-in mode (Super Admin only). LEGACY = unchanged production behaviour.
     * CHECKIN_POLICY_V2 = company default + weekly plan overrides with zone metadata (non-blocking).
     */
    attendanceSystemMode: {
      type: String,
      enum: Object.values(ATTENDANCE_SYSTEM_MODE),
      default: ATTENDANCE_SYSTEM_MODE.LEGACY
    },
    /** Company-wide default check-in point (used when mode = CHECKIN_POLICY_V2). */
    checkInPolicy: { type: checkInPolicySchema, default: undefined },
    /**
     * Per-company media flags (override env when set). null = inherit env default.
     * Lets a tenant be opted into media uploads independently of the global env flag.
     */
    mediaUploadEnabled: { type: Boolean, default: null },
    visitPhotosEnabled: { type: Boolean, default: null },
    expenseReceiptsEnabled: { type: Boolean, default: null },
    productMediaEnabled: { type: Boolean, default: null },
    /** Per-company temporary-file retention policy (Super Admin configurable). */
    mediaRetention: { type: mediaRetentionSchema, default: () => ({}) },
    /**
     * Incremented when attendanceSystemMode or checkInPolicy changes.
     * Clients compare to invalidate cached attendance config.
     */
    attendanceConfigVersion: { type: Number, default: 1, min: 1 },
    /**
     * PharmaERP Geo Platform — master config and per-feature toggles (Super Admin).
     * Legacy booleans (liveTrackingEnabled, geoFencingEnabled) are synced on write.
     */
    geoPlatform: {
      enabled: { type: Boolean, default: false },
      configVersion: { type: Number, default: 1, min: 1 },
      defaults: {
        mapCenter: {
          lat: { type: Number, default: null },
          lng: { type: Number, default: null }
        },
        mapZoom: { type: Number, default: 12, min: 1, max: 21 },
        countryCode: { type: String, trim: true, default: 'PK', maxlength: 8 }
      },
      features: {
        liveTracking: { type: Boolean, default: false },
        managerLiveMap: { type: Boolean, default: false },
        doctorMaps: { type: Boolean, default: false },
        pharmacyMaps: { type: Boolean, default: false },
        doctorLocationReviewMaps: { type: Boolean, default: false },
        callPointMaps: { type: Boolean, default: false },
        attendanceMaps: { type: Boolean, default: false },
        weeklyPlanMaps: { type: Boolean, default: false },
        dailyPlanMaps: { type: Boolean, default: false },
        activeVisitMaps: { type: Boolean, default: false },
        navigation: { type: Boolean, default: false },
        routeOptimization: { type: Boolean, default: false },
        routeReplay: { type: Boolean, default: false },
        heatMaps: { type: Boolean, default: false },
        territoryPolygons: { type: Boolean, default: false },
        geofencing: { type: Boolean, default: false },
        placesAutocomplete: { type: Boolean, default: false },
        geocoding: { type: Boolean, default: false },
        distanceAndEta: { type: Boolean, default: false },
        routeAnalytics: { type: Boolean, default: false },
        travelAnalytics: { type: Boolean, default: false },
        aiGeoApis: { type: Boolean, default: false }
      },
      limits: {
        maxGoogleCallsPerDay: { type: Number, default: null, min: 1 }
      },
      liveTracking: {
        heartbeatIntervalMs: { type: Number, default: 5 * 60 * 1000, min: 60000 },
        /** Max accuracy (m) for live pin / snapshot updates. */
        maxAccuracyMeters: { type: Number, default: 150, min: 10, max: 500 },
        /**
         * Max accuracy (m) retained for Route History.
         * Points between maxAccuracyMeters and this value are history-only (low confidence).
         */
        historyMaxAccuracyMeters: { type: Number, default: 500, min: 50, max: 2000 },
        /** Dense trail sample cadence for mobile (ms). */
        sampleIntervalMs: { type: Number, default: 60 * 1000, min: 30000 },
        /** Batch upload cadence for background breadcrumbs (ms). */
        uploadBatchIntervalMs: { type: Number, default: 90 * 1000, min: 25000 },
        /** Soft retention for purge jobs; Mongo TTL indexes remain 90 days. */
        retentionDays: { type: Number, default: 90, min: 7, max: 365 },
        staleDisplayMs: { type: Number, default: 30 * 60 * 1000, min: 60000 },
        trackingProfile: {
          type: String,
          enum: ['balanced', 'fresh', 'conservative'],
          default: 'balanced'
        },
        schedulerMinIntervalMs: { type: Number, default: 30 * 1000, min: 15000 },
        schedulerMaxIntervalMs: { type: Number, default: 10 * 60 * 1000, min: 60000 },
        geofenceContextEnabled: { type: Boolean, default: true }
      }
    }
  },
  { timestamps: true }
);

companySchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Company', companySchema);
