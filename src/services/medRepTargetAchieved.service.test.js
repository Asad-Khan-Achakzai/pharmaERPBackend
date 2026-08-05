const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { netAchievedPacksFromTotals } = require('./medRepTargetAchieved.service');

describe('netAchievedPacksFromTotals', () => {
  it('is deliveries minus returns minus amendments', () => {
    assert.equal(netAchievedPacksFromTotals({ delivered: 3443, returned: 234, amended: 0 }), 3209);
    assert.equal(netAchievedPacksFromTotals({ delivered: 100, returned: 10, amended: 5 }), 85);
  });

  it('allows negative nets (returns/amendments without matching deliveries in window)', () => {
    assert.equal(netAchievedPacksFromTotals({ delivered: 0, returned: 1, amended: 0 }), -1);
    assert.equal(netAchievedPacksFromTotals({ delivered: 10, returned: 0, amended: 15 }), -5);
  });

  it('treats missing / non-numeric inputs as 0', () => {
    assert.equal(netAchievedPacksFromTotals({}), 0);
    assert.equal(netAchievedPacksFromTotals({ delivered: '12', returned: null, amended: undefined }), 12);
  });
});
