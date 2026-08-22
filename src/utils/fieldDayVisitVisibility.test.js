const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { excludeAlreadyVisible, tagFieldDayObserverView } = require('./fieldDayVisitVisibility');

describe('excludeAlreadyVisible', () => {
  it('keeps Field Day visits that are not already owned or Partner-visible', () => {
    const out = excludeAlreadyVisible(
      [{ _id: 'ali-1' }, { _id: 'usman-1' }],
      [{ _id: 'ahmed-1' }],
      [{ _id: 'partner-1' }]
    );
    assert.deepEqual(
      out.map((i) => i._id),
      ['ali-1', 'usman-1']
    );
  });

  it('dedupes a visit that is already visible via Partner', () => {
    const out = excludeAlreadyVisible([{ _id: 'ali-1' }, { _id: 'usman-1' }], [], [{ _id: 'ali-1' }]);
    assert.deepEqual(
      out.map((i) => i._id),
      ['usman-1']
    );
  });

  it('dedupes a visit the manager already owns', () => {
    const out = excludeAlreadyVisible([{ _id: 'mine' }], [{ _id: 'mine' }], []);
    assert.deepEqual(out, []);
  });
});

describe('tagFieldDayObserverView', () => {
  it('marks observer view without setting co-visit participant flags', () => {
    const [row] = tagFieldDayObserverView([{ _id: 'ali-1', status: 'PENDING' }]);
    assert.equal(row.isFieldDayView, true);
    assert.equal(row.fieldDayRole, 'OBSERVER');
    assert.equal(row.isCoVisitParticipantView, undefined);
  });
});
