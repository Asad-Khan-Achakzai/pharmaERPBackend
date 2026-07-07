const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  rollupMetricsForUserIds,
  buildScopeHierarchy,
  userHasTeamRollup,
  sumCounters
} = require('./mrepHierarchyRollup.service');
const { emptyPlanCounters, emptyCoverageCounters, emptyAttendanceCounters, emptyTargetCounters, emptyOrderCounters } = require('./mrepKpiBulk.service');

const bundle = (overrides = {}) => ({
  plan: { ...emptyPlanCounters(), visited: 8, missed: 2, outOfOrderVisited: 1, unplannedVisited: 2, ...overrides.plan },
  coverage: { withTarget: 10, metOrExceeded: 7, ...overrides.coverage },
  attendance: { scoreNumerator: 20, ...overrides.attendance },
  target: { salesTarget: 100000, achievedSales: 50000, packsTarget: 0, achievedPacks: 0, hasTarget: true, ...overrides.target },
  orders: { orderCount: 5, returnedOrderCount: 1, grossRevenue: 48000, ...overrides.orders },
  grossSalesTp: 45000,
  workingDayCount: 30,
  ...overrides.root
});

describe('mrepHierarchyRollup', () => {
  it('userHasTeamRollup is false for MRep and true for ASM', () => {
    assert.equal(userHasTeamRollup('DEFAULT_MEDICAL_REP', 3), false);
    assert.equal(userHasTeamRollup('DEFAULT_ASM', 3), true);
    assert.equal(userHasTeamRollup(null, 2), true);
  });

  it('rollupMetricsForUserIds sums counters and recomputes coverage from totals', () => {
    const map = new Map([
      ['a', bundle({ coverage: { withTarget: 10, metOrExceeded: 8 } })],
      ['b', bundle({ coverage: { withTarget: 10, metOrExceeded: 6 }, target: { salesTarget: 50000, achievedSales: 25000, hasTarget: true } })]
    ]);
    const rolled = rollupMetricsForUserIds(['a', 'b'], map);
    assert.equal(rolled.coverage.coveragePercent, 70);
    assert.equal(rolled.coverage.doctorsTracked, 20);
    assert.equal(rolled.planExecution.missed, 4);
    assert.equal(rolled.target.salesTarget, 150000);
    assert.equal(rolled.target.achievedSales, 75000);
    assert.equal(rolled.target.salesAchievementPercent, 50);
    assert.equal(rolled.ordersInPeriod.orderCount, 10);
    assert.equal(rolled.totalGrossSalesTp, 90000);
  });

  it('visit completion uses visited / (visited + missed), not average of percentages', () => {
    const map = new Map([
      ['a', bundle({ plan: { ...emptyPlanCounters(), visited: 10, missed: 0 } })],
      ['b', bundle({ plan: { ...emptyPlanCounters(), visited: 0, missed: 10 } })]
    ]);
    const rolled = rollupMetricsForUserIds(['a', 'b'], map);
    assert.equal(rolled.planExecution.visitCompletionPercent, 50);
  });

  it('buildScopeHierarchy memoizes subtree and team size', () => {
    const users = [
      { _id: 'rm', managerId: null, roleId: { code: 'DEFAULT_RM' } },
      { _id: 'asm', managerId: 'rm', roleId: { code: 'DEFAULT_ASM' } },
      { _id: 'm1', managerId: 'asm', roleId: { code: 'DEFAULT_MEDICAL_REP' } },
      { _id: 'm2', managerId: 'asm', roleId: { code: 'DEFAULT_MEDICAL_REP' } }
    ];
    const scope = new Set(['rm', 'asm', 'm1', 'm2']);
    const { subtreeMemo, teamSize } = buildScopeHierarchy(users, scope);
    assert.deepEqual(subtreeMemo.get('rm'), ['rm', 'asm', 'm1', 'm2']);
    assert.equal(teamSize('asm'), 2);
    assert.equal(teamSize('rm'), 3);
  });

  it('sumCounters handles empty user list', () => {
    const acc = sumCounters([], new Map());
    assert.equal(acc.plan.visited, 0);
    assert.equal(acc.grossSalesTp, 0);
  });
});
