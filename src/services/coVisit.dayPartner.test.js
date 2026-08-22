/**
 * Day-level partner (accompaniment) semantics on top of co-visit participants.
 *
 * Precedence contract:
 *   visit-level partner (explicit / override) → day-level partner → none.
 *
 * Only the User model is stubbed (assertParticipantsAssignable); everything
 * else in coVisit.service is pure.
 */
const { describe, it } = require('node:test');
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

preloadStub('../models/User', {
  find: () => ({ select: () => ({ lean: async () => [] }) })
});

const coVisit = require('./coVisit.service');
const { CO_VISIT_PARTICIPANT_SOURCE } = require('../constants/enums');

const OWNER = '64b000000000000000000001';
const MANAGER_X = '64b000000000000000000002';
const MANAGER_Y = '64b000000000000000000003';

const visitEntry = (userId) =>
  coVisit.buildParticipantRecords([userId], OWNER, CO_VISIT_PARTICIPANT_SOURCE.VISIT)[0];
const dayEntry = (userId) =>
  coVisit.buildParticipantRecords([userId], OWNER, CO_VISIT_PARTICIPANT_SOURCE.DAY)[0];
/** Rows created before the source field existed. */
const legacyEntry = (userId) => {
  const e = visitEntry(userId);
  delete e.source;
  return e;
};

const ids = (participants) => participants.map((p) => String(p.employeeId));

describe('participant source semantics', () => {
  it('buildParticipantRecords defaults to VISIT source', () => {
    const [rec] = coVisit.buildParticipantRecords([MANAGER_X], OWNER);
    assert.equal(rec.source, 'VISIT');
    assert.equal(rec.lifecycleStatus, 'ACCEPTED');
  });

  it('treats legacy rows without a source as VISIT (explicit)', () => {
    assert.equal(coVisit.participantSource(legacyEntry(MANAGER_X)), 'VISIT');
    assert.equal(coVisit.isDaySourced(legacyEntry(MANAGER_X)), false);
    assert.equal(coVisit.isDaySourced(dayEntry(MANAGER_X)), true);
  });
});

describe('dayPartnerIdForYmd', () => {
  // 2026-08-12 is a Wednesday.
  const plan = { partnerByDay: { wednesday: MANAGER_X, thursday: null } };

  it('resolves the partner for the matching weekday', () => {
    assert.equal(coVisit.dayPartnerIdForYmd(plan, '2026-08-12'), MANAGER_X);
  });

  it('returns null for days without a partner', () => {
    assert.equal(coVisit.dayPartnerIdForYmd(plan, '2026-08-13'), null);
    assert.equal(coVisit.dayPartnerIdForYmd(plan, '2026-08-14'), null);
  });

  it('returns null when the plan has no partnerByDay (backward compat)', () => {
    assert.equal(coVisit.dayPartnerIdForYmd({}, '2026-08-12'), null);
    assert.equal(coVisit.dayPartnerIdForYmd(null, '2026-08-12'), null);
  });
});

describe('applyDayPartner', () => {
  it('adds the day partner to a visit with no partners', () => {
    const out = coVisit.applyDayPartner([], {
      nextId: MANAGER_X,
      ownerId: OWNER,
      invitedByUserId: OWNER
    });
    assert.deepEqual(ids(out), [MANAGER_X]);
    assert.equal(out[0].source, 'DAY');
  });

  it('replaces a previous DAY-sourced partner when the day partner changes', () => {
    const out = coVisit.applyDayPartner([dayEntry(MANAGER_X)], {
      nextId: MANAGER_Y,
      ownerId: OWNER,
      invitedByUserId: OWNER
    });
    assert.deepEqual(ids(out), [MANAGER_Y]);
    assert.equal(out[0].source, 'DAY');
  });

  it('removes the DAY-sourced partner when the day partner is cleared', () => {
    const out = coVisit.applyDayPartner([dayEntry(MANAGER_X)], {
      nextId: null,
      ownerId: OWNER,
      invitedByUserId: OWNER
    });
    assert.deepEqual(out, []);
  });

  it('never touches explicit VISIT-sourced partners', () => {
    const out = coVisit.applyDayPartner([visitEntry(MANAGER_Y)], {
      nextId: MANAGER_X,
      ownerId: OWNER,
      invitedByUserId: OWNER
    });
    assert.deepEqual(ids(out).sort(), [MANAGER_X, MANAGER_Y].sort());
    const bySrc = Object.fromEntries(out.map((p) => [String(p.employeeId), p.source]));
    assert.equal(bySrc[MANAGER_Y], 'VISIT');
    assert.equal(bySrc[MANAGER_X], 'DAY');
  });

  it('never touches legacy rows without a source', () => {
    const out = coVisit.applyDayPartner([legacyEntry(MANAGER_Y)], {
      nextId: null,
      ownerId: OWNER,
      invitedByUserId: OWNER
    });
    assert.deepEqual(ids(out), [MANAGER_Y]);
  });

  it('does not duplicate a partner already explicitly on the visit', () => {
    const out = coVisit.applyDayPartner([visitEntry(MANAGER_X)], {
      nextId: MANAGER_X,
      ownerId: OWNER,
      invitedByUserId: OWNER
    });
    assert.deepEqual(ids(out), [MANAGER_X]);
    assert.equal(out[0].source, 'VISIT');
  });

  it('never adds the owner as their own partner', () => {
    const out = coVisit.applyDayPartner([], {
      nextId: OWNER,
      ownerId: OWNER,
      invitedByUserId: OWNER
    });
    assert.deepEqual(out, []);
  });

  it('is idempotent (re-applying the same day partner changes nothing)', () => {
    const once = coVisit.applyDayPartner([], {
      nextId: MANAGER_X,
      ownerId: OWNER,
      invitedByUserId: OWNER
    });
    const twice = coVisit.applyDayPartner(once, {
      nextId: MANAGER_X,
      ownerId: OWNER,
      invitedByUserId: OWNER
    });
    assert.deepEqual(ids(twice), [MANAGER_X]);
    assert.equal(twice.length, 1);
  });
});
