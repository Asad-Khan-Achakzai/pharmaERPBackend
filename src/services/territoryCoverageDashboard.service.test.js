const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  pctOrNull,
  latestActivityStatus,
  DOCTOR_ACTIVITY_STATUS,
  MAX_DASHBOARD_RANGE_DAYS,
  assertDashboardRange,
  resolveRootKind,
  ROOT_KIND
} = require('./territoryCoverageDashboard.service');
const { PLAN_ITEM_STATUS } = require('../constants/enums');
const {
  DEFAULT_ASM_CODE,
  DEFAULT_RM_CODE,
  DEFAULT_MEDICAL_REP_CODE,
  ADMIN_ACCESS
} = require('../constants/rbac');

describe('territoryCoverageDashboard helpers', () => {
  it('pctOrNull returns null for empty denominator', () => {
    assert.equal(pctOrNull(5, 0), null);
    assert.equal(pctOrNull(0, 0), null);
  });

  it('pctOrNull rounds visited/assigned territory coverage', () => {
    assert.equal(pctOrNull(12, 200), 6);
    assert.equal(pctOrNull(12, 15), 80);
  });

  it('latestActivityStatus uses latest day not fixed priority', () => {
    const status = latestActivityStatus([
      { ymd: '2026-07-20', hasVisit: true, planStatuses: [PLAN_ITEM_STATUS.VISITED] },
      { ymd: '2026-07-21', hasVisit: false, planStatuses: [PLAN_ITEM_STATUS.MISSED] }
    ]);
    assert.equal(status, DOCTOR_ACTIVITY_STATUS.MISSED);
  });

  it('latestActivityStatus prefers visit on the latest day', () => {
    const status = latestActivityStatus([
      { ymd: '2026-07-21', hasVisit: true, planStatuses: [PLAN_ITEM_STATUS.MISSED] }
    ]);
    assert.equal(status, DOCTOR_ACTIVITY_STATUS.VISITED);
  });

  it('latestActivityStatus returns PLANNED for pending-only latest day', () => {
    const status = latestActivityStatus([
      { ymd: '2026-07-28', hasVisit: false, planStatuses: [PLAN_ITEM_STATUS.PENDING] }
    ]);
    assert.equal(status, DOCTOR_ACTIVITY_STATUS.PLANNED);
  });

  it('latestActivityStatus returns NOT_PLANNED when empty', () => {
    assert.equal(latestActivityStatus([]), DOCTOR_ACTIVITY_STATUS.NOT_PLANNED);
    assert.equal(latestActivityStatus(null), DOCTOR_ACTIVITY_STATUS.NOT_PLANNED);
  });

  it('assertDashboardRange rejects inverted and oversized ranges', () => {
    assert.throws(() => assertDashboardRange('2026-07-28', '2026-07-01', 'Asia/Karachi'), /from must/);
    assert.throws(
      () => assertDashboardRange('2025-01-01', '2026-07-01', 'Asia/Karachi'),
      new RegExp(String(MAX_DASHBOARD_RANGE_DAYS))
    );
  });

  it('assertDashboardRange accepts an 8-month custom range', () => {
    const bounds = assertDashboardRange('2026-01-23', '2026-07-28', 'Asia/Karachi');
    assert.ok(bounds.startDoc instanceof Date);
    assert.ok(bounds.endDoc instanceof Date);
  });

  it('assertDashboardRange accepts a valid short range', () => {
    const bounds = assertDashboardRange('2026-07-01', '2026-07-07', 'Asia/Karachi');
    assert.ok(bounds.startDoc instanceof Date);
    assert.ok(bounds.endDoc instanceof Date);
    assert.ok(bounds.visitRange.$gte instanceof Date);
  });

  it('resolveRootKind maps roles to hierarchy roots', () => {
    assert.equal(
      resolveRootKind({ permissions: [ADMIN_ACCESS], roleCode: 'DEFAULT_ADMIN' }),
      ROOT_KIND.COMPANY
    );
    assert.equal(resolveRootKind({ permissions: [], roleCode: DEFAULT_RM_CODE }), ROOT_KIND.ZONE);
    assert.equal(resolveRootKind({ permissions: [], roleCode: DEFAULT_ASM_CODE }), ROOT_KIND.AREA);
    assert.equal(
      resolveRootKind({ permissions: [], roleCode: DEFAULT_MEDICAL_REP_CODE }),
      ROOT_KIND.BRICK
    );
  });
});
