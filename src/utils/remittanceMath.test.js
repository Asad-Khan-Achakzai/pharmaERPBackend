/**
 * Run: node --test src/utils/remittanceMath.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { fifoApplyReceivedToOpenLines, classifyReceivedVsExpected } = require('./remittanceMath');

describe('fifoApplyReceivedToOpenLines', () => {
  test('exact remittance consumes all selected lines', () => {
    const a = { ledgerEntryId: 'a', collectionId: 'c1', open: 30000 };
    const b = { ledgerEntryId: 'b', collectionId: 'c2', open: 42000 };
    const c = { ledgerEntryId: 'c', collectionId: 'c3', open: 18000 };
    const d = { ledgerEntryId: 'd', collectionId: 'c4', open: 30000 };
    const { slices, unapplied } = fifoApplyReceivedToOpenLines([a, b, c, d], 120000);
    assert.equal(unapplied, 0);
    assert.equal(slices.length, 4);
    assert.equal(
      slices.reduce((s, x) => s + x.amount, 0),
      120000
    );
  });

  test('short remittance FIFO within selection leaves remainder on last lines', () => {
    const lines = [
      { ledgerEntryId: 'a', collectionId: 'c1', open: 30000 },
      { ledgerEntryId: 'b', collectionId: 'c2', open: 42000 },
      { ledgerEntryId: 'c', collectionId: 'c3', open: 18000 },
      { ledgerEntryId: 'd', collectionId: 'c4', open: 30000 }
    ];
    const { slices, unapplied } = fifoApplyReceivedToOpenLines(lines, 115000);
    assert.equal(unapplied, 0);
    assert.equal(slices[0].amount, 30000);
    assert.equal(slices[1].amount, 42000);
    assert.equal(slices[2].amount, 18000);
    assert.equal(slices[3].amount, 25000);
    const applied = slices.reduce((s, x) => s + x.amount, 0);
    assert.equal(applied, 115000);
  });

  test('does not pull in lines outside the selection', () => {
    const selected = [{ ledgerEntryId: 'a', collectionId: 'c1', open: 30000 }];
    const { slices, unapplied } = fifoApplyReceivedToOpenLines(selected, 30000);
    assert.equal(slices.length, 1);
    assert.equal(unapplied, 0);
  });

  test('partial selection A+B expected 72000 does not touch C or D', () => {
    const selected = [
      { ledgerEntryId: 'a', collectionId: 'c1', open: 30000 },
      { ledgerEntryId: 'b', collectionId: 'c2', open: 42000 }
    ];
    const { slices, unapplied } = fifoApplyReceivedToOpenLines(selected, 72000);
    assert.equal(unapplied, 0);
    assert.equal(slices.length, 2);
    assert.equal(
      slices.reduce((s, x) => s + x.amount, 0),
      72000
    );
  });

  test('received above selected expected leaves unapplied rather than inventing lines', () => {
    const selected = [{ ledgerEntryId: 'a', collectionId: 'c1', open: 30000 }];
    const { slices, unapplied } = fifoApplyReceivedToOpenLines(selected, 35000);
    assert.equal(slices[0].amount, 30000);
    assert.equal(unapplied, 5000);
  });
});

describe('classifyReceivedVsExpected', () => {
  test('balanced company share', () => {
    const r = classifyReceivedVsExpected(120000, 120000);
    assert.equal(r.status, 'BALANCED');
    assert.equal(r.difference, 0);
  });

  test('short vs company share is SHORT not vs total collected', () => {
    const r = classifyReceivedVsExpected(120000, 115000);
    assert.equal(r.status, 'SHORT');
    assert.equal(r.difference, -5000);
  });

  test('received above company share is EXCESS', () => {
    const r = classifyReceivedVsExpected(120000, 125000);
    assert.equal(r.status, 'EXCESS');
    assert.equal(r.difference, 5000);
  });

  test('200000 collected is not the expected remittance', () => {
    const mistaken = classifyReceivedVsExpected(200000, 200000);
    assert.equal(mistaken.status, 'BALANCED');
    const correct = classifyReceivedVsExpected(120000, 200000);
    assert.equal(correct.status, 'EXCESS');
  });
});
