const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isPlanLiveForPartnership,
  isPlanItemLiveForPartnership,
  filterLivePartnershipItems
} = require('./weeklyPlanPartnership');

describe('isPlanLiveForPartnership', () => {
  it('is true for ACTIVE plans', () => {
    assert.equal(isPlanLiveForPartnership({ status: 'ACTIVE', approvalRequired: true }), true);
  });

  it('is false for DRAFT plans that require approval', () => {
    assert.equal(isPlanLiveForPartnership({ status: 'DRAFT', approvalRequired: true }), false);
  });

  it('is false for SUBMITTED plans', () => {
    assert.equal(isPlanLiveForPartnership({ status: 'SUBMITTED', approvalRequired: true }), false);
  });

  it('is true for DRAFT plans that do not require approval', () => {
    assert.equal(isPlanLiveForPartnership({ status: 'DRAFT', approvalRequired: false }), true);
  });
});

describe('filterLivePartnershipItems', () => {
  it('hides Partner/Field Day visits whose weekly plan is not accepted', () => {
    const items = [
      { _id: 'draft', weeklyPlanId: { status: 'DRAFT', approvalRequired: true } },
      { _id: 'active', weeklyPlanId: { status: 'ACTIVE', approvalRequired: true } }
    ];
    assert.deepEqual(
      filterLivePartnershipItems(items).map((i) => i._id),
      ['active']
    );
  });

  it('keeps rows when the weekly plan is not populated', () => {
    assert.equal(isPlanItemLiveForPartnership({ _id: 'x', weeklyPlanId: '64c000000000000000000001' }), true);
  });
});

describe('hideFieldDayRepsPendingApproval', () => {
  it('drops reps whose weekly plan is still pending approval', () => {
    const { hideFieldDayRepsPendingApproval } = require('./weeklyPlanPartnership');
    const pending = new Set(['64b0000000000000000000a1']);
    const kept = hideFieldDayRepsPendingApproval(
      [{ _id: '64b0000000000000000000a1', name: 'Ali' }, { _id: '64b0000000000000000000a2', name: 'Usman' }],
      pending
    );
    assert.deepEqual(
      kept.map((r) => r._id),
      ['64b0000000000000000000a2']
    );
  });
});
