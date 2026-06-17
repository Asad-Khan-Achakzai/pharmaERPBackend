/**
 * Run: node --test src/utils/orderScope.util.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const ApiError = require('./ApiError');
const {
  applyOrderMedicalRepScope,
  assertOrderVisibleToUser,
  narrowMedicalRepScopeForQuery
} = require('./orderScope.util');

describe('orderScope.util', () => {
  test('applyOrderMedicalRepScope — admin may filter by query rep', () => {
    const repA = new mongoose.Types.ObjectId();
    const filter = {};
    applyOrderMedicalRepScope(filter, null, String(repA));
    assert.equal(String(filter.medicalRepId), String(repA));
  });

  test('applyOrderMedicalRepScope — admin with no query leaves filter open', () => {
    const filter = {};
    applyOrderMedicalRepScope(filter, null, undefined);
    assert.equal(filter.medicalRepId, undefined);
  });

  test('applyOrderMedicalRepScope — scoped user gets $in when no query', () => {
    const repA = new mongoose.Types.ObjectId();
    const repB = new mongoose.Types.ObjectId();
    const filter = {};
    applyOrderMedicalRepScope(filter, [repA, repB], undefined);
    assert.deepEqual(filter.medicalRepId.$in.map(String), [String(repA), String(repB)]);
  });

  test('applyOrderMedicalRepScope — scoped user may narrow to allowed rep', () => {
    const repA = new mongoose.Types.ObjectId();
    const repB = new mongoose.Types.ObjectId();
    const filter = {};
    applyOrderMedicalRepScope(filter, [repA, repB], String(repA));
    assert.equal(String(filter.medicalRepId), String(repA));
  });

  test('applyOrderMedicalRepScope — scoped user rejected for out-of-scope rep', () => {
    const repA = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    assert.throws(
      () => applyOrderMedicalRepScope({}, [repA], String(other)),
      (err) => err instanceof ApiError && err.statusCode === 403
    );
  });

  test('applyOrderMedicalRepScope — empty scope yields no rows', () => {
    const filter = {};
    applyOrderMedicalRepScope(filter, [], undefined);
    assert.deepEqual(filter.medicalRepId.$in, []);
  });

  test('assertOrderVisibleToUser — admin bypass', () => {
    const order = { medicalRepId: new mongoose.Types.ObjectId() };
    assert.doesNotThrow(() => assertOrderVisibleToUser(order, null));
  });

  test('assertOrderVisibleToUser — in-scope rep ok', () => {
    const repId = new mongoose.Types.ObjectId();
    const order = { medicalRepId: repId };
    assert.doesNotThrow(() => assertOrderVisibleToUser(order, [repId]));
  });

  test('assertOrderVisibleToUser — populated medicalRepId ok', () => {
    const repId = new mongoose.Types.ObjectId();
    const order = { medicalRepId: { _id: repId } };
    assert.doesNotThrow(() => assertOrderVisibleToUser(order, [repId]));
  });

  test('assertOrderVisibleToUser — out-of-scope throws 404', () => {
    const repId = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    assert.throws(
      () => assertOrderVisibleToUser({ medicalRepId: other }, [repId]),
      (err) => err instanceof ApiError && err.statusCode === 404
    );
  });

  test('narrowMedicalRepScopeForQuery — admin bypass', () => {
    const selfId = new mongoose.Types.ObjectId();
    assert.equal(narrowMedicalRepScopeForQuery(null, 'self', String(selfId)), null);
  });

  test('narrowMedicalRepScopeForQuery — manager self scope', () => {
    const selfId = new mongoose.Types.ObjectId();
    const otherId = new mongoose.Types.ObjectId();
    const narrowed = narrowMedicalRepScopeForQuery([selfId, otherId], 'self', String(selfId));
    assert.deepEqual(narrowed.map(String), [String(selfId)]);
  });

  test('narrowMedicalRepScopeForQuery — team scope unchanged', () => {
    const selfId = new mongoose.Types.ObjectId();
    const otherId = new mongoose.Types.ObjectId();
    const ids = [selfId, otherId];
    assert.equal(narrowMedicalRepScopeForQuery(ids, 'team', String(selfId)), ids);
  });
});
