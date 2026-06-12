const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { matchSlab, calculateProductIncentives } = require('./productIncentiveCalculator');

const slabs = [
  { fromPacks: 1, toPacks: 100, ratePerPack: 2 },
  { fromPacks: 101, toPacks: 200, ratePerPack: 3 },
  { fromPacks: 201, toPacks: null, ratePerPack: 5 }
];

describe('matchSlab', () => {
  it('matches first slab inclusively at upper bound', () => {
    const m = matchSlab(slabs, 100);
    assert.equal(m.ratePerPack, 2);
  });

  it('matches second slab at lower bound', () => {
    const m = matchSlab(slabs, 101);
    assert.equal(m.ratePerPack, 3);
  });

  it('matches open-ended top slab', () => {
    const m = matchSlab(slabs, 500);
    assert.equal(m.ratePerPack, 5);
  });

  it('returns null for zero qty', () => {
    assert.equal(matchSlab(slabs, 0), null);
  });
});

describe('calculateProductIncentives flat slab', () => {
  const rules = [
    {
      type: 'pack_slab',
      productId: 'prod1',
      includeBonusQty: true,
      slabs
    }
  ];

  it('applies flat slab rate to entire quantity (80 packs → 160)', () => {
    const map = new Map([['prod1', { physicalQty: 80, paidQty: 70, bonusQty: 10 }]]);
    const { lines, total } = calculateProductIncentives(rules, map);
    assert.equal(lines[0].amount, 160);
    assert.equal(total, 160);
  });

  it('applies flat slab rate to entire quantity (150 packs → 450)', () => {
    const map = new Map([['prod1', { physicalQty: 150, paidQty: 150, bonusQty: 0 }]]);
    const { lines, total } = calculateProductIncentives(rules, map);
    assert.equal(lines[0].amount, 450);
    assert.equal(total, 450);
  });

  it('respects includeBonusQty false using paid qty only', () => {
    const paidOnlyRules = [{ ...rules[0], includeBonusQty: false }];
    const map = new Map([['prod1', { physicalQty: 150, paidQty: 120, bonusQty: 30 }]]);
    const { lines } = calculateProductIncentives(paidOnlyRules, map);
    assert.equal(lines[0].deliveredQty, 120);
    assert.equal(lines[0].amount, 360);
  });

  it('returns zero when no slab matches', () => {
    const map = new Map();
    const { lines, total } = calculateProductIncentives(rules, map);
    assert.equal(lines[0].deliveredQty, 0);
    assert.equal(lines[0].amount, 0);
    assert.equal(total, 0);
  });
});
