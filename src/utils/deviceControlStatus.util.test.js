/**
 * Run: node --test src/utils/deviceControlStatus.util.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveVisibleDeviceChangeRequest,
  simulateSwitchingSequence
} = require('./deviceControlStatus.util');

describe('resolveVisibleDeviceChangeRequest', () => {
  test('PENDING wins over any history', () => {
    const pending = { _id: 'p1', status: 'PENDING', requestedDeviceId: 'B' };
    const latest = { _id: 'a1', status: 'APPROVED', requestedDeviceId: 'A' };
    const result = resolveVisibleDeviceChangeRequest({
      pending,
      latestForThisDevice: latest,
      boundDeviceId: 'A',
      currentDeviceId: 'A'
    });
    assert.equal(result, pending);
  });

  test('APPROVED only when this device is still bound', () => {
    const approvedB = { _id: 'b1', status: 'APPROVED', requestedDeviceId: 'B' };
    assert.deepEqual(
      resolveVisibleDeviceChangeRequest({
        pending: null,
        latestForThisDevice: approvedB,
        boundDeviceId: 'B',
        currentDeviceId: 'B'
      }),
      approvedB
    );
    // After rebind to A, B's old APPROVED must not surface (the A→B→A loop bug).
    assert.equal(
      resolveVisibleDeviceChangeRequest({
        pending: null,
        latestForThisDevice: approvedB,
        boundDeviceId: 'A',
        currentDeviceId: 'B'
      }),
      null
    );
  });

  test('REJECTED for this device is returned so user can request again', () => {
    const rejected = { _id: 'r1', status: 'REJECTED', requestedDeviceId: 'B' };
    assert.equal(
      resolveVisibleDeviceChangeRequest({
        pending: null,
        latestForThisDevice: rejected,
        boundDeviceId: 'A',
        currentDeviceId: 'B'
      }),
      rejected
    );
  });

  test('SUPERSEDED returns null', () => {
    const superseded = { _id: 's1', status: 'SUPERSEDED', requestedDeviceId: 'B' };
    assert.equal(
      resolveVisibleDeviceChangeRequest({
        pending: null,
        latestForThisDevice: superseded,
        boundDeviceId: 'A',
        currentDeviceId: 'B'
      }),
      null
    );
  });

  test('no history → null (show request form)', () => {
    assert.equal(
      resolveVisibleDeviceChangeRequest({
        pending: null,
        latestForThisDevice: null,
        boundDeviceId: 'A',
        currentDeviceId: 'B'
      }),
      null
    );
  });
});

describe('repeated device switching A↔B (50 cycles)', () => {
  test('after every switch only the bound device sees APPROVED; unbound can request', () => {
    const sequence = [];
    sequence.push('A');
    for (let i = 0; i < 50; i++) {
      sequence.push(i % 2 === 0 ? 'B' : 'A');
    }

    const { binding, visibility, history } = simulateSwitchingSequence(sequence);

    assert.equal(binding, sequence[sequence.length - 1]);
    assert.equal(history.filter((h) => h.status === 'APPROVED').length, 1);
    assert.equal(
      history.filter((h) => h.status === 'SUPERSEDED').length,
      history.length - 1
    );
    assert.equal(history.filter((h) => h.status === 'PENDING').length, 0);

    for (const [deviceId, visible] of Object.entries(visibility)) {
      if (deviceId === binding) {
        assert.ok(visible, `bound device ${deviceId} should see a request`);
        assert.equal(visible.status, 'APPROVED');
        assert.equal(visible.requestedDeviceId, binding);
      } else {
        assert.equal(
          visible,
          null,
          `unbound device ${deviceId} must not see stale APPROVED (got ${visible && visible.status})`
        );
      }
    }
  });

  test('A→B→A leaves B able to request again (null visibility)', () => {
    const { binding, visibility } = simulateSwitchingSequence(['B', 'A']);
    assert.equal(binding, 'A');
    assert.equal(visibility.A?.status, 'APPROVED');
    assert.equal(visibility.B, null);
  });

  test('multi-device A→B→C→D→A→C→B→D keeps single binding', () => {
    const sequence = ['A', 'B', 'C', 'D', 'A', 'C', 'B', 'D'];
    const { binding, visibility, history } = simulateSwitchingSequence(sequence);
    assert.equal(binding, 'D');
    assert.equal(history.filter((h) => h.status === 'APPROVED').length, 1);
    for (const d of ['A', 'B', 'C', 'D']) {
      if (d === 'D') {
        assert.equal(visibility[d]?.status, 'APPROVED');
      } else {
        assert.equal(visibility[d], null);
      }
    }
  });

  test('supersede marks prior APPROVED rows', () => {
    const { history } = simulateSwitchingSequence(['B', 'A', 'B']);
    const statuses = history.map((h) => h.status);
    assert.deepEqual(statuses, ['SUPERSEDED', 'SUPERSEDED', 'APPROVED']);
  });
});
