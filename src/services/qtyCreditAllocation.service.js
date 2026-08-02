/**
 * Qty-credit allocation policies for Returns and Amendments.
 *
 * Physical delta (packs removed) is split into paidDelta + bonusDelta.
 * Financial credits use paidDelta only; inventory / TP / packs use full physical delta.
 *
 * v1: BONUS_FIRST only. PAID_FIRST / PROPORTIONAL are stubs for future policies.
 */
const { roundPKR } = require('../utils/currency');

const QTY_CREDIT_ALLOCATION_POLICY = {
  BONUS_FIRST: 'BONUS_FIRST',
  PAID_FIRST: 'PAID_FIRST',
  PROPORTIONAL: 'PROPORTIONAL'
};

/** Official v1 policy for PharmaERP (amendments + returns). */
const DEFAULT_QTY_CREDIT_ALLOCATION_POLICY = QTY_CREDIT_ALLOCATION_POLICY.BONUS_FIRST;

const n = (v) => Math.max(0, Math.floor(Number(v) || 0));

/**
 * Resolve paid/bonus composition frozen on a delivery line snapshot.
 * Never reprices from current product masters.
 */
const resolveDeliveryPaidBonus = (dLine) => {
  const physical = n(dLine?.quantity);
  if (!physical) {
    return { physical: 0, paidDelivered: 0, bonusDelivered: 0 };
  }

  if (dLine?.paidQuantity != null || dLine?.bonusQuantity != null) {
    let paid =
      dLine.paidQuantity != null ? n(dLine.paidQuantity) : Math.max(0, physical - n(dLine.bonusQuantity));
    paid = Math.min(paid, physical);
    const bonus = Math.max(0, physical - paid);
    return { physical, paidDelivered: paid, bonusDelivered: bonus };
  }

  // Legacy lines without paid/bonus fields: treat all packs as paid (conservative).
  return { physical, paidDelivered: physical, bonusDelivered: 0 };
};

const allocateBonusFirst = (physicalDelta, remainingBonus, remainingPaid) => {
  const delta = n(physicalDelta);
  const remBonus = n(remainingBonus);
  const remPaid = n(remainingPaid);
  const available = remBonus + remPaid;
  if (delta > available) {
    throw new Error(
      `Physical credit ${delta} exceeds remaining paid+bonus composition ${available}`
    );
  }
  const bonusDelta = Math.min(delta, remBonus);
  const paidDelta = delta - bonusDelta;
  return { paidDelta, bonusDelta, physicalDelta: delta };
};

const allocatePaidFirst = (physicalDelta, remainingBonus, remainingPaid) => {
  const delta = n(physicalDelta);
  const remBonus = n(remainingBonus);
  const remPaid = n(remainingPaid);
  const available = remBonus + remPaid;
  if (delta > available) {
    throw new Error(
      `Physical credit ${delta} exceeds remaining paid+bonus composition ${available}`
    );
  }
  const paidDelta = Math.min(delta, remPaid);
  const bonusDelta = delta - paidDelta;
  return { paidDelta, bonusDelta, physicalDelta: delta };
};

/**
 * Preserve paid:bonus ratio of the *remaining* pool (integer via largest-remainder).
 */
const allocateProportional = (physicalDelta, remainingBonus, remainingPaid) => {
  const delta = n(physicalDelta);
  const remBonus = n(remainingBonus);
  const remPaid = n(remainingPaid);
  const available = remBonus + remPaid;
  if (delta > available) {
    throw new Error(
      `Physical credit ${delta} exceeds remaining paid+bonus composition ${available}`
    );
  }
  if (delta === 0 || available === 0) {
    return { paidDelta: 0, bonusDelta: 0, physicalDelta: delta };
  }
  const rawPaid = (delta * remPaid) / available;
  let paidDelta = Math.floor(rawPaid);
  let bonusDelta = delta - paidDelta;
  // Largest-remainder tweak when floor under-allocates paid share
  const paidFrac = rawPaid - paidDelta;
  if (paidFrac >= 0.5 && paidDelta < remPaid && bonusDelta > 0) {
    paidDelta += 1;
    bonusDelta -= 1;
  }
  if (paidDelta > remPaid) {
    bonusDelta += paidDelta - remPaid;
    paidDelta = remPaid;
  }
  if (bonusDelta > remBonus) {
    paidDelta += bonusDelta - remBonus;
    bonusDelta = remBonus;
  }
  return { paidDelta, bonusDelta, physicalDelta: delta };
};

/**
 * Split a physical qty credit into paidDelta / bonusDelta under the given policy.
 * @param {string} [policy]
 * @param {number} physicalDelta
 * @param {number} remainingBonus
 * @param {number} remainingPaid
 */
const allocatePhysicalDelta = (
  policy,
  physicalDelta,
  remainingBonus,
  remainingPaid
) => {
  const p = policy || DEFAULT_QTY_CREDIT_ALLOCATION_POLICY;
  switch (p) {
    case QTY_CREDIT_ALLOCATION_POLICY.BONUS_FIRST:
      return allocateBonusFirst(physicalDelta, remainingBonus, remainingPaid);
    case QTY_CREDIT_ALLOCATION_POLICY.PAID_FIRST:
      return allocatePaidFirst(physicalDelta, remainingBonus, remainingPaid);
    case QTY_CREDIT_ALLOCATION_POLICY.PROPORTIONAL:
      return allocateProportional(physicalDelta, remainingBonus, remainingPaid);
    default:
      throw new Error(`Unsupported qty credit allocation policy: ${p}`);
  }
};

/**
 * Apply prior credits (newest remaining pool) against a delivery composition.
 * Legacy rows without paidDelta/bonusDelta are interpreted with the active policy
 * for pool tracking only (historical money posts are never rewritten).
 *
 * @param {object} dLine delivery line snapshot
 * @param {Array<{ physicalQty: number, paidDelta?: number|null, bonusDelta?: number|null }>} priorCredits
 * @param {string} [policy]
 */
const remainingCompositionAfterPriors = (dLine, priorCredits = [], policy) => {
  const { paidDelivered, bonusDelivered, physical } = resolveDeliveryPaidBonus(dLine);
  let remPaid = paidDelivered;
  let remBonus = bonusDelivered;

  for (const c of priorCredits) {
    const hasSplit = c.paidDelta != null || c.bonusDelta != null;
    if (hasSplit) {
      remPaid = Math.max(0, remPaid - n(c.paidDelta));
      remBonus = Math.max(0, remBonus - n(c.bonusDelta));
      continue;
    }
    const phys = n(c.physicalQty ?? c.quantity ?? c.deltaQty);
    if (phys <= 0) continue;
    const split = allocatePhysicalDelta(policy, phys, remBonus, remPaid);
    remPaid = Math.max(0, remPaid - split.paidDelta);
    remBonus = Math.max(0, remBonus - split.bonusDelta);
  }

  return {
    physicalDelivered: physical,
    paidDelivered,
    bonusDelivered,
    remainingPaid: remPaid,
    remainingBonus: remBonus,
    remainingPhysical: remPaid + remBonus
  };
};

/**
 * Financial + cost snapshot from historical delivery line using Bonus-First (or other) split.
 * Revenue/shares from paidDelta; inventory cost from full physicalDelta.
 */
const computeMoneyFromAllocation = (dLine, allocation) => {
  const physicalDelta = n(allocation?.physicalDelta);
  const paidDelta = n(allocation?.paidDelta);
  const bonusDelta = n(allocation?.bonusDelta);
  const { paidDelivered } = resolveDeliveryPaidBonus(dLine);

  const avgCostAtTime = dLine?.avgCostAtTime || 0;
  const linePharmacyNet =
    dLine?.linePharmacyNet != null
      ? roundPKR(dLine.linePharmacyNet)
      : roundPKR((dLine?.finalSellingPrice || 0) * n(dLine?.quantity));

  const paidUnitNet =
    paidDelivered > 0 ? roundPKR(linePharmacyNet / paidDelivered) : 0;
  const creditAmount = roundPKR(paidUnitNet * paidDelta);

  const companyShareTotal = dLine?.companyShare != null ? roundPKR(dLine.companyShare) : null;
  const distributorShareTotal =
    dLine?.distributorShare != null ? roundPKR(dLine.distributorShare) : null;

  const companyShare =
    paidDelivered > 0 && companyShareTotal != null
      ? roundPKR((companyShareTotal / paidDelivered) * paidDelta)
      : roundPKR(
          creditAmount -
            (paidDelivered > 0 && distributorShareTotal != null
              ? roundPKR((distributorShareTotal / paidDelivered) * paidDelta)
              : 0)
        );

  const distributorShare =
    paidDelivered > 0 && distributorShareTotal != null
      ? roundPKR((distributorShareTotal / paidDelivered) * paidDelta)
      : roundPKR(creditAmount - companyShare);

  const lineCost = roundPKR(avgCostAtTime * physicalDelta);
  const totalProfit = roundPKR(creditAmount - lineCost);
  const profitPerUnit = physicalDelta > 0 ? roundPKR(totalProfit / physicalDelta) : 0;

  return {
    avgCostAtTime,
    /** Paid-unit net from delivery snapshot (CN rate). 0 when no paid packs on line. */
    finalSellingPrice: paidUnitNet,
    /** @deprecated blended unit — kept for callers; prefer finalSellingPrice as paid unit */
    blendedUnitNet:
      n(dLine?.quantity) > 0 ? roundPKR(linePharmacyNet / n(dLine.quantity)) : 0,
    lineQty: n(dLine?.quantity),
    paidDelivered,
    linePharmacyNet,
    paidUnitNet,
    paidDelta,
    bonusDelta,
    physicalDelta,
    creditAmount,
    lineCost,
    totalProfit,
    profitPerUnit,
    companyShare,
    distributorShare,
    allocationPolicy: allocation?.allocationPolicy || DEFAULT_QTY_CREDIT_ALLOCATION_POLICY
  };
};

/**
 * End-to-end: prior credits + physical delta → allocation + money (historical snapshots only).
 */
const planQtyCredit = ({
  dLine,
  physicalDelta,
  priorCredits = [],
  policy = DEFAULT_QTY_CREDIT_ALLOCATION_POLICY
}) => {
  const composition = remainingCompositionAfterPriors(dLine, priorCredits, policy);
  const allocation = allocatePhysicalDelta(
    policy,
    physicalDelta,
    composition.remainingBonus,
    composition.remainingPaid
  );
  const money = computeMoneyFromAllocation(dLine, {
    ...allocation,
    allocationPolicy: policy
  });
  return {
    policy,
    composition,
    allocation: { ...allocation, allocationPolicy: policy },
    ...money
  };
};

module.exports = {
  QTY_CREDIT_ALLOCATION_POLICY,
  DEFAULT_QTY_CREDIT_ALLOCATION_POLICY,
  resolveDeliveryPaidBonus,
  allocatePhysicalDelta,
  allocateBonusFirst,
  allocatePaidFirst,
  allocateProportional,
  remainingCompositionAfterPriors,
  computeMoneyFromAllocation,
  planQtyCredit
};
