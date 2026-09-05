const { roundPKR } = require('./currency');

const OPEN_EPS = 0.001;

/**
 * Apply received cash FIFO to pre-sorted open remittance-due lines (oldest first).
 * Caller must already restrict `lines` to the selected collections.
 */
const fifoApplyReceivedToOpenLines = (lines, receivedAmount) => {
  let remaining = roundPKR(receivedAmount);
  const slices = [];
  for (const line of lines || []) {
    if (remaining <= OPEN_EPS) break;
    const open = roundPKR(line.open || 0);
    if (open <= OPEN_EPS) continue;
    const take = roundPKR(Math.min(open, remaining));
    if (take <= 0) continue;
    slices.push({
      ledgerEntryId: line.ledgerEntryId,
      collectionId: line.collectionId,
      deliveryId: line.deliveryId,
      amount: take
    });
    remaining = roundPKR(remaining - take);
  }
  return { slices, unapplied: roundPKR(Math.max(0, remaining)) };
};

/**
 * Model A: received cannot exceed expected company share.
 * Short (received < expected) is allowed.
 */
const classifyReceivedVsExpected = (expected, received) => {
  const e = roundPKR(expected);
  const r = roundPKR(received);
  const difference = roundPKR(r - e);
  let status = 'BALANCED';
  if (difference > OPEN_EPS) status = 'EXCESS';
  else if (difference < -OPEN_EPS) status = 'SHORT';
  return { expected: e, received: r, difference, status };
};

module.exports = {
  OPEN_EPS,
  fifoApplyReceivedToOpenLines,
  classifyReceivedVsExpected
};
