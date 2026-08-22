/**
 * Tests for V2 check-in point resolution + zone evaluation.
 *
 * Regression focus: the production bug where the weekly-plan CP was only
 * honored for ACTIVE plans, so real check-ins (DRAFT/SUBMITTED plans) fell
 * back to the company default point — including (0,0) placeholders — and
 * always evaluated OUT_OF_ZONE.
 *
 * Mongo models are stubbed; businessTime/luxon run for real.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function preloadStub(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports
  };
}

const state = {
  plans: [],
  callPoints: [],
  doctors: [],
  company: null
};

const chain = (result) => ({
  select() {
    return this;
  },
  sort() {
    return this;
  },
  lean: async () => result
});

preloadStub('../models/WeeklyPlan', {
  find: () => chain(state.plans)
});
preloadStub('../models/CallPoint', {
  findOne: (q) =>
    chain(
      state.callPoints.find(
        (cp) => String(cp._id) === String(q._id) && cp.isActive !== false
      ) || null
    )
});
preloadStub('../models/Doctor', {
  findOne: (q) => chain(state.doctors.find((d) => String(d._id) === String(q._id)) || null)
});
preloadStub('../models/PlanItem', {
  findOne: () => chain(null)
});
preloadStub('../models/Attendance', {});
preloadStub('../models/Company', {
  findById: () => chain(state.company)
});

const svc = require('./checkInPolicyServiceV2');
const { distanceMeters } = require('./geoFence.service');

const TZ = 'Asia/Karachi';
// 2026-08-10 is a Monday; the test business day 2026-08-12 is a Wednesday.
const WEEK = {
  weekStartDate: new Date('2026-08-10T00:00:00Z'),
  weekEndDate: new Date('2026-08-16T00:00:00Z')
};
const WEDNESDAY_YMD = '2026-08-12';
const THURSDAY_YMD = '2026-08-13';

// Quetta-area fixture (matches real production data shape).
const CP_A = { _id: 'cpA', name: 'Civil Hospital', latitude: 30.194575, longitude: 67.008879, isActive: true };
const CP_B = { _id: 'cpB', name: 'Bolan Medical', latitude: 30.191677, longitude: 66.976366, isActive: true };

const companyV2 = (checkInPolicy) => ({
  _id: 'co1',
  attendanceSystemMode: 'CHECKIN_POLICY_V2',
  timeZone: TZ,
  name: 'Test Co',
  checkInPolicy
});

const plan = (status, cpByDay, extra = {}) => ({
  _id: `plan-${status}`,
  status,
  cpByDay,
  updatedAt: new Date('2026-08-11T00:00:00Z'),
  ...WEEK,
  ...extra
});

const resolve = (company, businessYmd = WEDNESDAY_YMD) =>
  svc.resolveActiveCheckInPoint({ company, employeeId: 'rep1', businessYmd, timeZone: TZ });

beforeEach(() => {
  state.plans = [];
  state.callPoints = [CP_A, CP_B];
  state.doctors = [];
  state.company = null;
});

describe('resolveActiveCheckInPoint — CP resolution', () => {
  it('uses the CP from an ACTIVE plan for the correct weekday', async () => {
    const company = companyV2({ latitude: 33.6972, longitude: 73.0502, radiusMeters: 500 });
    state.plans = [plan('ACTIVE', { wednesday: 'cpA' })];

    const point = await resolve(company);
    assert.equal(point.source, 'WEEKLY_PLAN_CP');
    assert.equal(String(point.refId), 'cpA');
    assert.equal(point.latitude, CP_A.latitude);
    assert.equal(point.longitude, CP_A.longitude);
    assert.equal(point.radiusMeters, 500);
    assert.equal(point.locationName, 'Civil Hospital');
  });

  it('uses the CP from a SUBMITTED plan (production regression)', async () => {
    const company = companyV2({ latitude: 0, longitude: 0, radiusMeters: 499 });
    state.plans = [plan('SUBMITTED', { wednesday: 'cpA' })];

    const point = await resolve(company);
    assert.equal(point.source, 'WEEKLY_PLAN_CP');
    assert.equal(String(point.refId), 'cpA');
    // Configured radius applies even though the default point coords are unusable.
    assert.equal(point.radiusMeters, 499);
  });

  it('uses the CP from a DRAFT plan', async () => {
    const company = companyV2(null);
    state.plans = [plan('DRAFT', { wednesday: 'cpB' })];

    const point = await resolve(company);
    assert.equal(String(point.refId), 'cpB');
  });

  it('prefers ACTIVE over DRAFT when both cover the day', async () => {
    const company = companyV2(null);
    state.plans = [plan('DRAFT', { wednesday: 'cpB' }), plan('ACTIVE', { wednesday: 'cpA' })];

    const point = await resolve(company);
    assert.equal(String(point.refId), 'cpA');
  });

  it('resolves a different CP for a different weekday', async () => {
    const company = companyV2(null);
    state.plans = [plan('ACTIVE', { wednesday: 'cpA', thursday: 'cpB' })];

    const wed = await resolve(company, WEDNESDAY_YMD);
    const thu = await resolve(company, THURSDAY_YMD);
    assert.equal(String(wed.refId), 'cpA');
    assert.equal(String(thu.refId), 'cpB');
  });

  it('falls back to a valid company default when the CP is inactive', async () => {
    const company = companyV2({
      latitude: 33.6972,
      longitude: 73.0502,
      radiusMeters: 500,
      locationName: 'Main office'
    });
    state.callPoints = [{ ...CP_A, isActive: false }];
    state.plans = [plan('ACTIVE', { wednesday: 'cpA' })];

    const point = await resolve(company);
    assert.equal(point.source, 'COMPANY_DEFAULT');
    assert.equal(point.locationName, 'Main office');
  });

  it('ignores a plan whose week does not cover the day', async () => {
    const company = companyV2(null);
    state.plans = [
      plan('ACTIVE', { wednesday: 'cpA' }, {
        weekStartDate: new Date('2026-08-03T00:00:00Z'),
        weekEndDate: new Date('2026-08-09T00:00:00Z')
      })
    ];

    const point = await resolve(company);
    assert.equal(point, null);
  });
});

describe('resolveActiveCheckInPoint — company default hygiene', () => {
  it('treats a (0,0) placeholder default as not configured (no bogus point)', async () => {
    const company = companyV2({ latitude: 0, longitude: 0, radiusMeters: 499 });
    state.plans = [];

    const point = await resolve(company);
    assert.equal(point, null);
  });

  it('returns a valid company default when no CP plan exists', async () => {
    const company = companyV2({
      latitude: 33.6972,
      longitude: 73.0502,
      radiusMeters: 500,
      locationName: 'Main office'
    });
    state.plans = [];

    const point = await resolve(company);
    assert.equal(point.source, 'COMPANY_DEFAULT');
    assert.equal(point.radiusMeters, 500);
  });

  it('returns null for a non-V2 company', async () => {
    const company = { ...companyV2(null), attendanceSystemMode: 'LEGACY' };
    const point = await resolve(company);
    assert.equal(point, null);
  });
});

describe('evaluateGpsAgainstPoint', () => {
  const point = {
    latitude: CP_A.latitude,
    longitude: CP_A.longitude,
    radiusMeters: 150,
    locationName: 'Civil Hospital'
  };

  it('reports WITHIN_ZONE at the CP', () => {
    const r = svc.evaluateGpsAgainstPoint(point, CP_A.latitude + 0.0005, CP_A.longitude);
    assert.equal(r.attendanceLocationStatus, 'WITHIN_ZONE');
    assert.ok(r.distanceFromCheckInPoint < 150);
  });

  it('reports OUT_OF_ZONE beyond the radius', () => {
    const r = svc.evaluateGpsAgainstPoint(point, CP_A.latitude + 0.01, CP_A.longitude);
    assert.equal(r.attendanceLocationStatus, 'OUT_OF_ZONE');
    assert.ok(r.distanceFromCheckInPoint > 1000);
  });

  it('yields no verdict for NaN coordinates instead of OUT_OF_ZONE', () => {
    const r = svc.evaluateGpsAgainstPoint(point, Number('abc'), CP_A.longitude);
    assert.equal(r.attendanceLocationStatus, undefined);
    assert.equal(r.distanceFromCheckInPoint, null);
  });

  it('yields no verdict when there is no resolved point', () => {
    const r = svc.evaluateGpsAgainstPoint(null, CP_A.latitude, CP_A.longitude);
    assert.equal(r.attendanceLocationStatus, undefined);
  });
});

describe('distanceMeters hardening', () => {
  it('returns null for NaN input', () => {
    assert.equal(distanceMeters(NaN, 67, 30, 67), null);
  });

  it('returns null for string input', () => {
    assert.equal(distanceMeters('30', 67, 30, 67), null);
  });

  it('computes a plausible haversine distance', () => {
    const d = distanceMeters(30.1946, 67.0089, 30.1956, 67.0089); // ~0.001° lat
    assert.ok(Math.abs(d - 111) < 3, `expected ~111m, got ${d}`);
  });
});
