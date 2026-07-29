const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Collection = require('../models/Collection');
const Voucher = require('../models/Voucher');
const Settlement = require('../models/Settlement');
const SettlementAllocation = require('../models/SettlementAllocation');
const DeliveryRecord = require('../models/DeliveryRecord');
const Order = require('../models/Order');
const ReturnRecord = require('../models/ReturnRecord');
const Distributor = require('../models/Distributor');
const ApiError = require('../utils/ApiError');
const { roundPKR } = require('../utils/currency');
const {
  LEDGER_TYPE,
  LEDGER_ENTITY_TYPE,
  LEDGER_REFERENCE_TYPE,
  COLLECTOR_TYPE,
  SETTLEMENT_DIRECTION,
  LEDGER_COLLECTION_PORTION,
  GL_SOURCE_MODULE,
  VOUCHER_STATUS,
  ORDER_STATUS
} = require('../constants/enums');
const glBridge = require('./glBridge.service');
const glPosting = require('./glPosting.service');
const moneyAccountService = require('./moneyAccount.service');
const arDocumentOpen = require('./arDocumentOpen.service');
const {
  resolveArOpenEngine,
  useDocumentOpenEngine,
  AR_OPEN_ENGINE
} = require('../constants/arArchitecture');

const nd = { isDeleted: { $ne: true } };
const OPEN_EPS = 0.001;

const oid = (id) => new mongoose.Types.ObjectId(id);

/** Returns ObjectId or null — never throws CastError on bad / empty values. */
const safeOid = (id) => {
  if (id == null || id === '') return null;
  const s = String(id);
  if (s === 'null' || s === 'undefined') return null;
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  // Reject 12-char non-hex strings that isValid incorrectly accepts in some mongoose versions
  try {
    return new mongoose.Types.ObjectId(s);
  } catch {
    return null;
  }
};

const safeOids = (ids) =>
  [...new Set((ids || []).map((id) => safeOid(id)).filter(Boolean).map((id) => String(id)))].map(
    (s) => new mongoose.Types.ObjectId(s)
  );

const getCommissionPercent = (distributor) => {
  const p =
    distributor.commissionPercentOnTP != null
      ? distributor.commissionPercentOnTP
      : distributor.discountOnTP ?? 0;
  return roundPKR(p);
};

/**
 * Per delivered line (snapshotted at delivery; never recomputed at payment).
 * TP Total = TP × Qty. Pharmacy discount applies to TP total only.
 * Distributor % is commission on TP only (independent of pharmacy discount).
 * Company share = Pharmacy payable − Distributor share.
 */
const computeLineSnapshot = (orderItem, qty, distributor) => {
  const commissionPct = getCommissionPercent(distributor);
  const effectiveTP = orderItem.tpAtTime;
  const tpLineTotal = roundPKR(effectiveTP * qty);
  const pharmacyDiscountPct = orderItem.clinicDiscount ?? 0;
  const pharmacyDiscountAmount = roundPKR((tpLineTotal * pharmacyDiscountPct) / 100);
  const linePharmacyNet = roundPKR(tpLineTotal - pharmacyDiscountAmount);
  const distributorShare = roundPKR((tpLineTotal * commissionPct) / 100);
  const companyShare = roundPKR(linePharmacyNet - distributorShare);
  if (companyShare < -0.001) {
    throw new ApiError(400, 'Company share would be negative; reduce distributor commission on TP or pharmacy discount.');
  }
  const finalSellingPrice = qty > 0 ? roundPKR(linePharmacyNet / qty) : 0;

  return {
    tpLineTotal,
    distributorShare,
    linePharmacyNet,
    companyShare,
    finalSellingPrice,
    commissionPct
  };
};

/**
 * Per order line at create/update: full ordered qty, same math as computeLineSnapshot (delivery).
 * Snapshots are not recomputed later.
 */
const computeOrderLinePreview = (orderItem, distributor) => {
  const clinic = orderItem.clinicDiscount ?? 0;
  const distDisc = orderItem.distributorDiscount ?? 0;
  if (clinic < 0 || distDisc < 0) {
    throw new ApiError(400, 'Discount percentages must be zero or greater.');
  }
  const paidQty = Number(orderItem.quantity) || 0;
  const bonusQty = Number(orderItem.bonusQuantity) || 0;
  const physicalQty = paidQty + bonusQty;
  const snap = computeLineSnapshot(orderItem, paidQty, distributor);
  const grossSnap = computeLineSnapshot(orderItem, physicalQty, distributor);
  const pharmacyDiscountAmount = roundPKR(snap.tpLineTotal - snap.linePharmacyNet);
  const inventoryCostAmount = roundPKR((orderItem.castingAtTime || 0) * physicalQty);
  return {
    grossAmount: grossSnap.tpLineTotal,
    pharmacyDiscountAmount,
    netAfterPharmacy: snap.linePharmacyNet,
    distributorCommissionAmount: snap.distributorShare,
    finalCompanyAmount: snap.companyShare,
    inventoryCostAmount
  };
};

/**
 * Aggregate order-level preview totals from line previews (rounded PKR sums).
 */
const enrichOrderItemsWithFinancialSnapshot = (orderItems, distributor) => {
  const lineSnapshots = orderItems.map((oi) => computeOrderLinePreview(oi, distributor));
  const sumField = (key) => roundPKR(lineSnapshots.reduce((s, r) => s + r[key], 0));
  const totalBonusQuantity = orderItems.reduce((s, oi) => s + (Number(oi.bonusQuantity) || 0), 0);
  const totals = {
    totalAmount: sumField('grossAmount'),
    pharmacyDiscountAmount: sumField('pharmacyDiscountAmount'),
    amountAfterPharmacyDiscount: sumField('netAfterPharmacy'),
    distributorCommissionAmount: sumField('distributorCommissionAmount'),
    finalCompanyRevenue: sumField('finalCompanyAmount'),
    totalBonusQuantity,
    totalCastingCost: sumField('inventoryCostAmount')
  };
  const items = orderItems.map((oi, i) => ({
    ...oi,
    ...lineSnapshots[i]
  }));
  return { items, totals };
};

const buildLedgerBase = (companyId, entityType, entityId, type, amount, referenceType, referenceId, description, date, meta) => ({
  companyId,
  entityType,
  entityId,
  type,
  amount: roundPKR(amount),
  referenceType,
  referenceId,
  description,
  date: date || new Date(),
  meta: meta || undefined
});

/**
 * Delivery: pharmacy receivable only. Company/distributor split is snapshotted on DeliveryRecord;
 * distributor remittance and commission post only when cash is collected (see postCollectionClearing).
 */
const postDeliveryLedgers = async (session, ctx) => {
  const { companyId, pharmacyId, deliveryId, orderId, invoiceNumber, pharmacyNetPayable, date } = ctx;

  const d = date || new Date();
  const meta = { deliveryId, orderId };

  const entries = [
    buildLedgerBase(
      companyId,
      LEDGER_ENTITY_TYPE.PHARMACY,
      pharmacyId,
      LEDGER_TYPE.DEBIT,
      pharmacyNetPayable,
      LEDGER_REFERENCE_TYPE.DELIVERY,
      deliveryId,
      `Delivery ${invoiceNumber} — pharmacy receivable`,
      d,
      meta
    )
  ];

  const created = await Ledger.create(entries, { session, ordered: true });
  return { entries: created, clearingDrLedgerId: null };
};

/**
 * Apply amount against open balances for a preferred delivery id list (FIFO within that list).
 * @returns remaining amount not applied
 */
const applyCreditToDeliveryIds = (openByDelivery, amount, deliveryIds) => {
  let remaining = roundPKR(amount);
  for (const id of deliveryIds) {
    if (remaining <= OPEN_EPS) break;
    if (openByDelivery[id] === undefined) continue;
    const cur = openByDelivery[id];
    if (cur <= OPEN_EPS) continue;
    const take = roundPKR(Math.min(cur, remaining));
    openByDelivery[id] = roundPKR(cur - take);
    remaining = roundPKR(remaining - take);
  }
  return remaining;
};

/**
 * Global FIFO across all open deliveries (ObjectId sort — legacy collection/payment path).
 */
const applyCreditFifoGlobal = (openByDelivery, amount) => {
  return applyCreditToDeliveryIds(openByDelivery, amount, Object.keys(openByDelivery).sort());
};

/**
 * For RETURN credits missing meta.deliveryId, map ReturnRecord → that order's deliveries
 * (oldest delivery first). Used only by AR_OPEN_ENGINE=legacy rollback path.
 * @deprecated Prefer ReturnRecord.allocations (document application SoT).
 */
const resolveReturnCreditDeliveryTargets = async (companyId, crLines, session) => {
  const map = new Map();
  const returnRefIds = [];
  for (const cr of crLines) {
    const refType = cr.referenceType;
    if (refType !== LEDGER_REFERENCE_TYPE.RETURN) continue;
    if (cr.meta?.deliveryId) continue;
    if (Array.isArray(cr.meta?.allocations) && cr.meta.allocations.length) continue;
    const rid = safeOid(cr.referenceId);
    if (!rid) continue;
    returnRefIds.push(rid);
  }
  if (!returnRefIds.length) return map;

  const cid = safeOid(companyId);
  if (!cid) return map;

  const returns = await ReturnRecord.find({
    companyId: cid,
    _id: { $in: returnRefIds },
    isDeleted: { $ne: true }
  })
    .select('_id orderId')
    .session(session || null)
    .lean();

  if (!returns.length) return map;

  const orderIds = safeOids(returns.map((r) => r.orderId));
  if (!orderIds.length) return map;

  const deliveries = await DeliveryRecord.find({
    companyId: cid,
    orderId: { $in: orderIds },
    isDeleted: { $ne: true }
  })
    .select('_id orderId deliveredAt')
    .sort({ deliveredAt: 1, createdAt: 1 })
    .session(session || null)
    .lean();

  const delsByOrder = new Map();
  for (const d of deliveries) {
    const key = String(d.orderId);
    if (!delsByOrder.has(key)) delsByOrder.set(key, []);
    delsByOrder.get(key).push(String(d._id));
  }

  for (const ret of returns) {
    if (!ret.orderId) continue;
    map.set(String(ret._id), delsByOrder.get(String(ret.orderId)) || []);
  }
  return map;
};

/**
 * Apply pharmacy ledger DRs then CRs to produce open balance per delivery id.
 * Shared by single-pharmacy receivable state and outstanding-collections bulk rollups.
 *
 * - Allocated credits (meta.deliveryId) reduce that delivery.
 * - RETURN credits without deliveryId prefer that return's order deliveries (fixes historical posts).
 * - Other unallocated credits (collections/payments) use global FIFO by delivery id.
 *
 * @param {object} [opts]
 * @param {Map<string, string[]>} [opts.returnTargetsByReferenceId]
 */
const buildOpenByDeliveryFromLedgerLines = (drLines, crLines, opts = {}) => {
  const returnTargetsByReferenceId = opts.returnTargetsByReferenceId || null;
  const openByDelivery = {};
  for (const dr of drLines) {
    if (!dr?.referenceId) continue;
    const id = String(dr.referenceId);
    if (!mongoose.Types.ObjectId.isValid(id)) continue;
    openByDelivery[id] = roundPKR((openByDelivery[id] || 0) + dr.amount);
  }

  for (const cr of crLines) {
    const amt = roundPKR(cr.amount);
    if (Array.isArray(cr.meta?.allocations) && cr.meta.allocations.length) {
      let applied = 0;
      for (const alloc of cr.meta.allocations) {
        if (!alloc?.deliveryId) continue;
        const id = String(alloc.deliveryId);
        if (!mongoose.Types.ObjectId.isValid(id)) continue;
        const slice = roundPKR(alloc.amount != null ? alloc.amount : 0);
        if (slice <= OPEN_EPS) continue;
        if (openByDelivery[id] !== undefined) {
          openByDelivery[id] = roundPKR(openByDelivery[id] - slice);
        }
        applied = roundPKR(applied + slice);
      }
      const leftover = roundPKR(amt - applied);
      if (leftover > OPEN_EPS) {
        applyCreditFifoGlobal(openByDelivery, leftover);
      }
    } else if (cr.meta?.deliveryId) {
      const id = String(cr.meta.deliveryId);
      if (mongoose.Types.ObjectId.isValid(id) && openByDelivery[id] !== undefined) {
        openByDelivery[id] = roundPKR(openByDelivery[id] - amt);
      } else {
        // Delivery key missing (edge) — do not drop credit; fall through to FIFO.
        applyCreditFifoGlobal(openByDelivery, amt);
      }
    } else if (
      cr.referenceType === LEDGER_REFERENCE_TYPE.RETURN &&
      returnTargetsByReferenceId &&
      returnTargetsByReferenceId.has(String(cr.referenceId))
    ) {
      const targets = returnTargetsByReferenceId.get(String(cr.referenceId)) || [];
      let remaining = applyCreditToDeliveryIds(openByDelivery, amt, targets);
      if (remaining > OPEN_EPS) {
        remaining = applyCreditFifoGlobal(openByDelivery, remaining);
      }
    } else {
      applyCreditFifoGlobal(openByDelivery, amt);
    }
  }
  return openByDelivery;
};

/**
 * Legacy open: pharmacy ledger DRs then CRs (meta.deliveryId / return-target map).
 * Retained for AR_OPEN_ENGINE=legacy rollback only.
 */
const computePharmacyReceivableStateLegacy = async (companyId, pharmacyId, session) => {
  const q = { companyId: oid(companyId), entityId: oid(pharmacyId), entityType: LEDGER_ENTITY_TYPE.PHARMACY, isDeleted: { $ne: true } };
  const drLines = await Ledger.find({
    ...q,
    type: LEDGER_TYPE.DEBIT,
    referenceType: { $in: [LEDGER_REFERENCE_TYPE.DELIVERY, LEDGER_REFERENCE_TYPE.ORDER] }
  })
    .session(session || null)
    .sort({ date: 1, createdAt: 1 });
  const crLines = await Ledger.find({
    ...q,
    type: LEDGER_TYPE.CREDIT,
    referenceType: { $in: [LEDGER_REFERENCE_TYPE.COLLECTION, LEDGER_REFERENCE_TYPE.PAYMENT, LEDGER_REFERENCE_TYPE.RETURN, LEDGER_REFERENCE_TYPE.AMENDMENT] }
  })
    .session(session || null)
    .sort({ date: 1, createdAt: 1 });

  const returnTargetsByReferenceId = await resolveReturnCreditDeliveryTargets(companyId, crLines, session);
  const openByDelivery = buildOpenByDeliveryFromLedgerLines(drLines, crLines, {
    returnTargetsByReferenceId
  });

  const idList = deliveryIdsFromOpen(openByDelivery);
  const deliveries =
    idList.length === 0
      ? []
      : await DeliveryRecord.find({
          companyId: oid(companyId),
          _id: { $in: idList }
        })
          .session(session || null)
          .sort({ deliveredAt: 1 });

  const pharmacyOrders = await Order.find({ companyId: oid(companyId), pharmacyId: oid(pharmacyId) })
    .select('_id')
    .session(session || null);
  const pharmacyOrderIdSet = new Set(pharmacyOrders.map((o) => o._id.toString()));

  const orderIds = [...new Set(deliveries.map((d) => d.orderId.toString()))];
  const orders = await Order.find({ _id: { $in: orderIds } })
    .select('distributorId pharmacyId status')
    .session(session || null);
  const orderMap = {};
  orders.forEach((o) => {
    orderMap[o._id.toString()] = o;
  });

  const rows = deliveries
    .filter((d) => pharmacyOrderIdSet.has(d.orderId.toString()))
    .map((d) => {
      const id = d._id.toString();
      const o = orderMap[d.orderId.toString()];
      let open = roundPKR(openByDelivery[id] ?? 0);
      if (o?.status === ORDER_STATUS.RETURNED) {
        open = 0;
      }
      return {
        deliveryId: d._id,
        orderId: d.orderId,
        distributorId: o?.distributorId,
        pharmacyNetPayable: roundPKR(d.pharmacyNetPayable ?? d.totalAmount),
        companyShareTotal: roundPKR(d.companyShareTotal ?? 0),
        distributorShareTotal: roundPKR(d.distributorShareTotal ?? 0),
        deliveredAt: d.deliveredAt,
        open: roundPKR(Math.max(0, open))
      };
    });

  const totalOpen = roundPKR(rows.reduce((s, r) => s + Math.max(0, r.open), 0));
  return { rows, totalOpen, openByDelivery };
};

/**
 * Load pharmacy receivable open rows.
 * Default: document allocations (Collection + ReturnRecord) — enterprise SoT.
 */
const computePharmacyReceivableState = async (companyId, pharmacyId, session) => {
  if (!useDocumentOpenEngine()) {
    return computePharmacyReceivableStateLegacy(companyId, pharmacyId, session);
  }

  const docState = await arDocumentOpen.computeOpenFromDocumentAllocations(
    companyId,
    pharmacyId,
    session
  );

  if (resolveArOpenEngine() === AR_OPEN_ENGINE.SHADOW) {
    const legacy = await computePharmacyReceivableStateLegacy(companyId, pharmacyId, session);
    arDocumentOpen.maybeLogShadowDivergence(companyId, pharmacyId, docState, legacy.totalOpen);
  }

  return {
    rows: docState.rows.map((r) => ({
      deliveryId: r.deliveryId,
      orderId: r.orderId,
      distributorId: r.distributorId,
      pharmacyNetPayable: r.pharmacyNetPayable,
      companyShareTotal: r.companyShareTotal,
      distributorShareTotal: r.distributorShareTotal,
      deliveredAt: r.deliveredAt,
      open: r.open
    })),
    totalOpen: docState.totalOpen,
    openByDelivery: docState.openByDelivery,
    pharmacyOpen: docState.pharmacyOpen,
    ledgerNet: docState.ledgerNet
  };
};

/**
 * Bulk open totals per pharmacy (same rules as computePharmacyReceivableState).
 * @returns {Promise<Map<string, number>>} pharmacyId → totalOpen
 */
const computeOpenTotalsByPharmacyLegacy = async (companyId, pharmacyIds) => {
  const result = new Map();
  const ids = safeOids(pharmacyIds);
  if (!ids.length) return result;

  const cid = safeOid(companyId);
  if (!cid) return result;

  const [drLines, crLines] = await Promise.all([
    Ledger.find({
      companyId: cid,
      entityType: LEDGER_ENTITY_TYPE.PHARMACY,
      entityId: { $in: ids },
      isDeleted: { $ne: true },
      type: LEDGER_TYPE.DEBIT,
      referenceType: { $in: [LEDGER_REFERENCE_TYPE.DELIVERY, LEDGER_REFERENCE_TYPE.ORDER] }
    })
      .select('entityId referenceId amount date createdAt meta referenceType')
      .sort({ date: 1, createdAt: 1 })
      .lean(),
    Ledger.find({
      companyId: cid,
      entityType: LEDGER_ENTITY_TYPE.PHARMACY,
      entityId: { $in: ids },
      isDeleted: { $ne: true },
      type: LEDGER_TYPE.CREDIT,
      referenceType: {
        $in: [
          LEDGER_REFERENCE_TYPE.COLLECTION,
          LEDGER_REFERENCE_TYPE.PAYMENT,
          LEDGER_REFERENCE_TYPE.RETURN
        ]
      }
    })
      .select('entityId referenceId amount date createdAt meta referenceType')
      .sort({ date: 1, createdAt: 1 })
      .lean()
  ]);

  const drByPharmacy = new Map();
  const crByPharmacy = new Map();
  for (const line of drLines) {
    const key = String(line.entityId);
    if (!drByPharmacy.has(key)) drByPharmacy.set(key, []);
    drByPharmacy.get(key).push(line);
  }
  for (const line of crLines) {
    const key = String(line.entityId);
    if (!crByPharmacy.has(key)) crByPharmacy.set(key, []);
    crByPharmacy.get(key).push(line);
  }

  const returnTargetsByReferenceId = await resolveReturnCreditDeliveryTargets(companyId, crLines, null);

  const openByDelivery = {};
  const deliveryPharmacy = new Map();
  for (const pid of ids) {
    const key = String(pid);
    const openMap = buildOpenByDeliveryFromLedgerLines(
      drByPharmacy.get(key) || [],
      crByPharmacy.get(key) || [],
      { returnTargetsByReferenceId }
    );
    for (const [did, open] of Object.entries(openMap)) {
      openByDelivery[did] = open;
      deliveryPharmacy.set(did, key);
    }
  }

  const openDeliveryIds = safeOids(
    Object.keys(openByDelivery).filter((id) => roundPKR(openByDelivery[id] || 0) > OPEN_EPS)
  );
  if (!openDeliveryIds.length) {
    for (const pid of ids) result.set(String(pid), 0);
    return result;
  }

  const deliveries = await DeliveryRecord.find({
    companyId: cid,
    _id: { $in: openDeliveryIds },
    isDeleted: { $ne: true }
  })
    .select('_id orderId')
    .lean();

  const orderIds = safeOids(deliveries.map((d) => d.orderId));
  const orderStatus = new Map();
  if (orderIds.length) {
    const orders = await Order.find({
      _id: { $in: orderIds },
      companyId: cid,
      isDeleted: { $ne: true }
    })
      .select('_id status')
      .lean();
    for (const o of orders) orderStatus.set(String(o._id), o.status);
  }

  for (const pid of ids) result.set(String(pid), 0);

  for (const d of deliveries) {
    if (!d.orderId) continue;
    if (orderStatus.get(String(d.orderId)) === ORDER_STATUS.RETURNED) continue;
    const open = roundPKR(Math.max(0, openByDelivery[String(d._id)] || 0));
    if (open <= OPEN_EPS) continue;
    const pharmacyKey = deliveryPharmacy.get(String(d._id));
    if (!pharmacyKey) continue;
    result.set(pharmacyKey, roundPKR((result.get(pharmacyKey) || 0) + open));
  }

  return result;
};

/**
 * Bulk open totals per pharmacy (same rules as computePharmacyReceivableState).
 * @returns {Promise<Map<string, number>>} pharmacyId → totalOpen
 */
const computeOpenTotalsByPharmacy = async (companyId, pharmacyIds) => {
  if (!useDocumentOpenEngine()) {
    return computeOpenTotalsByPharmacyLegacy(companyId, pharmacyIds);
  }
  return arDocumentOpen.computeOpenTotalsByPharmacyFromDocuments(companyId, pharmacyIds);
};

function deliveryIdsFromOpen(openByDelivery) {
  return safeOids(Object.keys(openByDelivery));
}

/**
 * FIFO allocate collection amount against oldest deliveries with positive open balance.
 */
const fifoAllocateCollection = (amount, rows) => {
  const sorted = [...rows].filter((r) => r.open > 0.001).sort((a, b) => new Date(a.deliveredAt) - new Date(b.deliveredAt));
  let remaining = roundPKR(amount);
  const allocations = [];

  for (const row of sorted) {
    if (remaining <= 0) break;
    const take = roundPKR(Math.min(row.open, remaining));
    if (take <= 0) continue;
    allocations.push({
      deliveryId: row.deliveryId,
      orderId: row.orderId,
      distributorId: row.distributorId,
      amount: take,
      companyShareTotal: row.companyShareTotal,
      distributorShareTotal: row.distributorShareTotal,
      pharmacyNetPayable: row.pharmacyNetPayable
    });
    remaining = roundPKR(remaining - take);
  }

  const allocSum = roundPKR(allocations.reduce((s, a) => s + a.amount, 0));
  if (allocSum + 0.001 < roundPKR(amount)) {
    throw new ApiError(400, 'Collection amount exceeds outstanding pharmacy balance');
  }
  return allocations;
};

const sliceByRatios = (allocAmount, pharmacyNetPayable, companyShareTotal, distributorShareTotal) => {
  if (pharmacyNetPayable <= 0) {
    return { sliceCompany: 0, sliceDist: roundPKR(allocAmount) };
  }
  const rC = companyShareTotal / pharmacyNetPayable;
  const rD = distributorShareTotal / pharmacyNetPayable;
  let sliceCompany = roundPKR(allocAmount * rC);
  let sliceDist = roundPKR(allocAmount * rD);
  const diff = roundPKR(allocAmount - sliceCompany - sliceDist);
  sliceCompany = roundPKR(sliceCompany + diff);
  return { sliceCompany, sliceDist };
};

const postCollectionClearing = async (session, companyId, collectorType, distributorId, slice, collectionId, date) => {
  const { sliceCompany, sliceDist } = slice;
  const d = date || new Date();
  const meta = { deliveryId: slice.deliveryId, orderId: slice.orderId };
  const ref = LEDGER_REFERENCE_TYPE.COLLECTION;
  const entries = [];

  const metaBase = { ...meta };

  if (collectorType === COLLECTOR_TYPE.COMPANY) {
    // Company holds all cash; commission on TP for this slice is payable to distributor.
    if (sliceDist > 0) {
      entries.push(
        buildLedgerBase(
          companyId,
          LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
          distributorId,
          LEDGER_TYPE.CREDIT,
          sliceDist,
          ref,
          collectionId,
          'Collection (company collector) — commission on TP payable to distributor',
          d,
          { ...metaBase, portion: LEDGER_COLLECTION_PORTION.COMMISSION_PAYABLE_TO_DISTRIBUTOR }
        )
      );
    }
  } else {
    // Distributor holds cash: company share must be remitted; distributor keeps commission on TP slice.
    if (sliceCompany > 0) {
      entries.push(
        buildLedgerBase(
          companyId,
          LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
          distributorId,
          LEDGER_TYPE.DEBIT,
          sliceCompany,
          ref,
          collectionId,
          'Collection (distributor collector) — remit to company (company share of cash)',
          d,
          { ...metaBase, portion: LEDGER_COLLECTION_PORTION.REMITTANCE_DUE_TO_COMPANY }
        )
      );
    }
    if (sliceDist > 0) {
      entries.push(
        buildLedgerBase(
          companyId,
          LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
          distributorId,
          LEDGER_TYPE.CREDIT,
          sliceDist,
          ref,
          collectionId,
          'Collection (distributor collector) — distributor commission on TP (this slice)',
          d,
          { ...metaBase, portion: LEDGER_COLLECTION_PORTION.DISTRIBUTOR_COMMISSION_ON_COLLECTION }
        )
      );
    }
  }

  if (entries.length) await Ledger.create(entries, { session, ordered: true });
};

/**
 * Create Collection + ledger lines (pharmacy CR + clearing) inside a transaction.
 */
const createCollection = async (companyId, data, reqUser, session) => {
  const {
    pharmacyId,
    collectorType,
    distributorId: collectingDistributorId,
    amount,
    paymentMethod,
    moneyAccountId,
    referenceNumber,
    date,
    notes
  } = data;

  const moneyAcc = await moneyAccountService.assertMoneyAccount(companyId, moneyAccountId, session);

  let state = await computePharmacyReceivableState(companyId, pharmacyId, session);

  if (collectorType === COLLECTOR_TYPE.DISTRIBUTOR) {
    if (!collectingDistributorId) {
      throw new ApiError(400, 'distributorId is required when the collector is a distributor');
    }
    const distDoc = await Distributor.findOne({ _id: collectingDistributorId, companyId: oid(companyId) }).session(session);
    if (!distDoc) throw new ApiError(404, 'Distributor not found');
    const did = oid(collectingDistributorId);
    const rows = state.rows.filter((r) => r.distributorId && r.distributorId.toString() === did.toString());
    const totalOpen = roundPKR(rows.reduce((s, r) => s + Math.max(0, r.open), 0));
    state = { ...state, rows, totalOpen };
    if (totalOpen < 0.001) {
      throw new ApiError(400, 'No outstanding receivable from this pharmacy for the selected distributor');
    }
  }

  if (state.totalOpen + 0.001 < roundPKR(amount)) {
    const msg =
      collectorType === COLLECTOR_TYPE.DISTRIBUTOR
        ? 'Collection amount exceeds outstanding balance for this pharmacy with the selected distributor'
        : 'Collection amount exceeds total outstanding pharmacy balance';
    throw new ApiError(400, msg);
  }

  const rawAlloc = fifoAllocateCollection(amount, state.rows);
  const allocations = rawAlloc.map((a) => {
    const { sliceCompany, sliceDist } = sliceByRatios(
      a.amount,
      a.pharmacyNetPayable,
      a.companyShareTotal,
      a.distributorShareTotal
    );
    return {
      deliveryId: a.deliveryId,
      orderId: a.orderId,
      distributorId: a.distributorId,
      amount: a.amount,
      sliceCompany,
      sliceDist
    };
  });

  const [collection] = await Collection.create(
    [
      {
        companyId,
        pharmacyId,
        distributorId: collectorType === COLLECTOR_TYPE.DISTRIBUTOR ? oid(collectingDistributorId) : undefined,
        collectorType,
        amount: roundPKR(amount),
        paymentMethod,
        moneyAccountId: moneyAcc._id,
        moneyAccountNature: moneyAcc.moneyAccountNature || (moneyAcc.isBank ? 'BANK' : 'CASH'),
        referenceNumber,
        collectedBy: reqUser.userId,
        date: date || new Date(),
        notes,
        allocations: allocations.map((a) => ({
          deliveryId: a.deliveryId,
          orderId: a.orderId,
          distributorId: a.distributorId,
          amount: a.amount
        }))
      }
    ],
    { session, ordered: true }
  );

  const d = date || new Date();
  const ledgerPharmacy = allocations.map((a) =>
    buildLedgerBase(
      companyId,
      LEDGER_ENTITY_TYPE.PHARMACY,
      pharmacyId,
      LEDGER_TYPE.CREDIT,
      a.amount,
      LEDGER_REFERENCE_TYPE.COLLECTION,
      collection._id,
      'Collection against pharmacy receivable',
      d,
      { deliveryId: a.deliveryId, orderId: a.orderId }
    )
  );
  if (ledgerPharmacy.length) await Ledger.create(ledgerPharmacy, { session, ordered: true });

  for (const a of allocations) {
    await postCollectionClearing(
      session,
      companyId,
      collectorType,
      a.distributorId,
      { ...a, deliveryId: a.deliveryId, orderId: a.orderId },
      collection._id,
      d
    );
  }

  const createdLedgerRows = await Ledger.find({
    companyId: oid(companyId),
    referenceType: LEDGER_REFERENCE_TYPE.COLLECTION,
    referenceId: collection._id,
    ...{ isDeleted: { $ne: true } }
  })
    .session(session)
    .select('_id');

  await glBridge.postCollectionGl(
    session,
    companyId,
    {
      collectionId: collection._id,
      pharmacyId,
      amount: roundPKR(amount),
      paymentMethod,
      moneyAccountId: moneyAcc._id,
      date: d,
      narration: notes || 'Pharmacy collection',
      ledgerEntryIds: createdLedgerRows.map((r) => r._id)
    },
    reqUser
  );

  return collection;
};

const softDeleteWithSession = async (doc, userId, session) => {
  doc.isDeleted = true;
  doc.deletedAt = new Date();
  doc.deletedBy = userId || null;
  await doc.save({ session });
};

const findCollectionGlVoucher = async (companyId, collectionId, session) =>
  Voucher.findOne({
    companyId: oid(companyId),
    sourceModule: GL_SOURCE_MODULE.COLLECTION,
    sourceRefId: oid(collectionId),
    status: VOUCHER_STATUS.POSTED,
    reversedVoucherId: null,
    ...nd
  }).session(session || null);

const assertNoSettlementAgainstCollection = async (companyId, collectionId, session) => {
  const ledgerRows = await Ledger.find({
    companyId: oid(companyId),
    referenceType: LEDGER_REFERENCE_TYPE.COLLECTION,
    referenceId: oid(collectionId),
    ...nd
  })
    .session(session || null)
    .select('_id');
  if (!ledgerRows.length) return;
  const ledgerIds = ledgerRows.map((r) => r._id);
  const allocCount = await SettlementAllocation.countDocuments({
    companyId: oid(companyId),
    ledgerEntryId: { $in: ledgerIds },
    ...nd
  }).session(session || null);
  if (allocCount > 0) {
    throw new ApiError(
      409,
      'Cannot reverse: a settlement already allocated against this collection. Reverse the settlement first.'
    );
  }
};

/**
 * Safe metadata edit only — amount, pharmacy, collector, and money account cannot change after posting.
 */
const updateCollection = async (companyId, id, body, reqUser, session) => {
  const forbidden = ['amount', 'pharmacyId', 'collectorType', 'distributorId', 'paymentMethod', 'moneyAccountId'];
  if (forbidden.some((k) => body[k] !== undefined)) {
    throw new ApiError(
      400,
      'Amount, pharmacy, collector, and accounts cannot be changed — reverse and record a new collection'
    );
  }

  const collection = await Collection.findOne({ _id: oid(id), companyId: oid(companyId) }).session(session);
  if (!collection) throw new ApiError(404, 'Collection not found');

  if (body.date !== undefined) collection.date = new Date(body.date);
  if (body.notes !== undefined) {
    collection.notes =
      body.notes != null && String(body.notes).trim() !== '' ? String(body.notes).trim() : undefined;
  }
  if (body.referenceNumber !== undefined) {
    collection.referenceNumber =
      body.referenceNumber != null && String(body.referenceNumber).trim() !== ''
        ? String(body.referenceNumber).trim()
        : undefined;
  }

  collection.updatedBy = reqUser.userId;
  await collection.save({ session });

  if (body.date !== undefined) {
    await Ledger.updateMany(
      {
        companyId: oid(companyId),
        referenceType: LEDGER_REFERENCE_TYPE.COLLECTION,
        referenceId: collection._id,
        ...nd
      },
      { $set: { date: collection.date, updatedBy: reqUser.userId } },
      { session }
    );
  }

  const voucher = await findCollectionGlVoucher(companyId, collection._id, session);
  if (voucher) {
    if (body.date !== undefined) voucher.date = collection.date;
    if (body.notes !== undefined) voucher.narration = collection.notes || 'Pharmacy collection';
    voucher.updatedBy = reqUser.userId;
    await voucher.save({ session });
  }

  return collection;
};

/**
 * Undo FIFO allocation, ledger clearing, and GL for a collection (soft-delete + voucher reversal).
 */
const reverseCollection = async (companyId, id, body, reqUser, session) => {
  const collection = await Collection.findOne({ _id: oid(id), companyId: oid(companyId) }).session(session);
  if (!collection) throw new ApiError(404, 'Collection not found');

  await assertNoSettlementAgainstCollection(companyId, id, session);

  const voucher = await findCollectionGlVoucher(companyId, collection._id, session);
  if (voucher) {
    await glPosting.reverseVoucher(companyId, voucher._id, reqUser, session);
  }

  const ledgerRows = await Ledger.find({
    companyId: oid(companyId),
    referenceType: LEDGER_REFERENCE_TYPE.COLLECTION,
    referenceId: collection._id,
    ...nd
  }).session(session);

  for (const row of ledgerRows) {
    await softDeleteWithSession(row, reqUser.userId, session);
  }

  await softDeleteWithSession(collection, reqUser.userId, session);

  return {
    reversed: true,
    collectionId: collection._id,
    reversalReason: body?.reversalReason || null
  };
};

/** Sum of settlement allocations applied to a ledger line for a given settlement direction. */
const sumAllocatedForLine = async (companyId, distributorId, ledgerEntryId, settlementDirection, session) => {
  const agg = await SettlementAllocation.aggregate([
    {
      $match: {
        companyId: oid(companyId),
        distributorId: oid(distributorId),
        ledgerEntryId: oid(ledgerEntryId),
        isDeleted: { $ne: true }
      }
    },
    {
      $lookup: {
        from: 'settlements',
        localField: 'settlementId',
        foreignField: '_id',
        as: 's'
      }
    },
    { $unwind: '$s' },
    { $match: { 's.direction': settlementDirection } },
    { $group: { _id: null, s: { $sum: '$amount' } } }
  ]).session(session || null);
  return agg[0]?.s || 0;
};

/**
 * FIFO: settle distributor → company against open REMITTANCE_DUE_TO_COMPANY collection DR lines.
 */
const fifoSettlementDistributorToCompany = async (companyId, distributorId, amount, session) => {
  const cid = oid(companyId);
  const did = oid(distributorId);

  const lines = await Ledger.find({
    companyId: cid,
    entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
    entityId: did,
    referenceType: LEDGER_REFERENCE_TYPE.COLLECTION,
    type: LEDGER_TYPE.DEBIT,
    'meta.portion': LEDGER_COLLECTION_PORTION.REMITTANCE_DUE_TO_COMPANY,
    isDeleted: { $ne: true }
  })
    .session(session || null)
    .sort({ date: 1, createdAt: 1 });

  const relevant = [];
  for (const line of lines) {
    const allocated = await sumAllocatedForLine(
      companyId,
      distributorId,
      line._id,
      SETTLEMENT_DIRECTION.DISTRIBUTOR_TO_COMPANY,
      session
    );
    const open = roundPKR(line.amount - allocated);
    if (open > 0.001) {
      relevant.push({
        ledgerEntryId: line._id,
        deliveryId: line.meta?.deliveryId,
        deliveredAt: line.date,
        open
      });
    }
  }

  relevant.sort((a, b) => new Date(a.deliveredAt) - new Date(b.deliveredAt));

  let remaining = roundPKR(amount);
  const slices = [];
  for (const r of relevant) {
    if (remaining <= 0) break;
    const take = roundPKR(Math.min(r.open, remaining));
    if (take <= 0) continue;
    slices.push({ ledgerEntryId: r.ledgerEntryId, deliveryId: r.deliveryId, amount: take });
    remaining = roundPKR(remaining - take);
  }

  const applied = roundPKR(slices.reduce((s, x) => s + x.amount, 0));
  if (applied + 0.001 < roundPKR(amount)) {
    throw new ApiError(400, 'Settlement amount exceeds open remittance due from distributor to company');
  }
  return slices;
};

/**
 * FIFO: settle company → distributor against open COMMISSION_PAYABLE_TO_DISTRIBUTOR collection CR lines.
 */
const fifoSettlementCompanyToDistributor = async (companyId, distributorId, amount, session) => {
  const cid = oid(companyId);
  const did = oid(distributorId);

  const lines = await Ledger.find({
    companyId: cid,
    entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
    entityId: did,
    referenceType: LEDGER_REFERENCE_TYPE.COLLECTION,
    type: LEDGER_TYPE.CREDIT,
    'meta.portion': LEDGER_COLLECTION_PORTION.COMMISSION_PAYABLE_TO_DISTRIBUTOR,
    isDeleted: { $ne: true }
  })
    .session(session || null)
    .sort({ date: 1, createdAt: 1 });

  const relevant = [];
  for (const line of lines) {
    const allocated = await sumAllocatedForLine(
      companyId,
      distributorId,
      line._id,
      SETTLEMENT_DIRECTION.COMPANY_TO_DISTRIBUTOR,
      session
    );
    const open = roundPKR(line.amount - allocated);
    if (open > 0.001) {
      relevant.push({
        ledgerEntryId: line._id,
        deliveryId: line.meta?.deliveryId,
        deliveredAt: line.date,
        open
      });
    }
  }

  relevant.sort((a, b) => new Date(a.deliveredAt) - new Date(b.deliveredAt));

  let remaining = roundPKR(amount);
  const slices = [];
  for (const r of relevant) {
    if (remaining <= 0) break;
    const take = roundPKR(Math.min(r.open, remaining));
    if (take <= 0) continue;
    slices.push({ ledgerEntryId: r.ledgerEntryId, deliveryId: r.deliveryId, amount: take });
    remaining = roundPKR(remaining - take);
  }

  const applied = roundPKR(slices.reduce((s, x) => s + x.amount, 0));
  if (applied + 0.001 < roundPKR(amount)) {
    throw new ApiError(400, 'Settlement amount exceeds open commission payable to distributor');
  }
  return slices;
};

const createSettlement = async (companyId, data, reqUser, session) => {
  const {
    distributorId,
    direction,
    amount,
    paymentMethod,
    moneyAccountId,
    referenceNumber,
    date,
    notes,
    isNetSettlement,
    grossDistributorToCompany,
    grossCompanyToDistributor
  } = data;

  const moneyAcc = await moneyAccountService.assertMoneyAccount(companyId, moneyAccountId, session);

  const slices =
    direction === SETTLEMENT_DIRECTION.DISTRIBUTOR_TO_COMPANY
      ? await fifoSettlementDistributorToCompany(companyId, distributorId, amount, session)
      : await fifoSettlementCompanyToDistributor(companyId, distributorId, amount, session);

  const [settlement] = await Settlement.create(
    [
      {
        companyId,
        distributorId,
        direction,
        amount: roundPKR(amount),
        paymentMethod,
        moneyAccountId: moneyAcc._id,
        moneyAccountNature: moneyAcc.moneyAccountNature || (moneyAcc.isBank ? 'BANK' : 'CASH'),
        referenceNumber,
        settledBy: reqUser.userId,
        date: date || new Date(),
        notes,
        isNetSettlement: !!isNetSettlement,
        grossDistributorToCompany,
        grossCompanyToDistributor
      }
    ],
    { session, ordered: true }
  );

  const d = date || new Date();
  const ledgerType =
    direction === SETTLEMENT_DIRECTION.DISTRIBUTOR_TO_COMPANY ? LEDGER_TYPE.CREDIT : LEDGER_TYPE.DEBIT;
  const desc =
    direction === SETTLEMENT_DIRECTION.DISTRIBUTOR_TO_COMPANY
      ? 'Settlement: distributor → company'
      : 'Settlement: company → distributor';

  await Ledger.create(
    [
      buildLedgerBase(
        companyId,
        LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
        distributorId,
        ledgerType,
        amount,
        LEDGER_REFERENCE_TYPE.SETTLEMENT,
        settlement._id,
        desc,
        d,
        undefined
      )
    ],
    { session, ordered: true }
  );

  const allocDocs = slices.map((s) => ({
    companyId,
    settlementId: settlement._id,
    distributorId,
    ledgerEntryId: s.ledgerEntryId,
    amount: s.amount
  }));
  if (allocDocs.length) await SettlementAllocation.create(allocDocs, { session, ordered: true });

  return settlement;
};

/**
 * Safe metadata edit only — amount, distributor, direction, and payment method cannot change after posting.
 */
const updateSettlement = async (companyId, id, body, reqUser, session) => {
  const forbidden = [
    'amount',
    'distributorId',
    'direction',
    'paymentMethod',
    'moneyAccountId',
    'isNetSettlement',
    'grossDistributorToCompany',
    'grossCompanyToDistributor'
  ];
  if (forbidden.some((k) => body[k] !== undefined)) {
    throw new ApiError(
      400,
      'Amount, distributor, direction, and payment method cannot be changed — reverse and record a new settlement'
    );
  }

  const settlement = await Settlement.findOne({ _id: oid(id), companyId: oid(companyId) }).session(session);
  if (!settlement) throw new ApiError(404, 'Settlement not found');

  if (body.date !== undefined) settlement.date = new Date(body.date);
  if (body.notes !== undefined) {
    settlement.notes =
      body.notes != null && String(body.notes).trim() !== '' ? String(body.notes).trim() : undefined;
  }
  if (body.referenceNumber !== undefined) {
    settlement.referenceNumber =
      body.referenceNumber != null && String(body.referenceNumber).trim() !== ''
        ? String(body.referenceNumber).trim()
        : undefined;
  }

  settlement.updatedBy = reqUser.userId;
  await settlement.save({ session });

  if (body.date !== undefined) {
    await Ledger.updateMany(
      {
        companyId: oid(companyId),
        referenceType: LEDGER_REFERENCE_TYPE.SETTLEMENT,
        referenceId: settlement._id,
        ...nd
      },
      { $set: { date: settlement.date, updatedBy: reqUser.userId } },
      { session }
    );
  }

  return settlement;
};

/**
 * Undo FIFO allocation links and distributor-clearing ledger for a settlement.
 */
const reverseSettlement = async (companyId, id, body, reqUser, session) => {
  const settlement = await Settlement.findOne({ _id: oid(id), companyId: oid(companyId) }).session(session);
  if (!settlement) throw new ApiError(404, 'Settlement not found');

  const allocations = await SettlementAllocation.find({
    companyId: oid(companyId),
    settlementId: settlement._id,
    ...nd
  }).session(session);

  for (const alloc of allocations) {
    await softDeleteWithSession(alloc, reqUser.userId, session);
  }

  const ledgerRows = await Ledger.find({
    companyId: oid(companyId),
    referenceType: LEDGER_REFERENCE_TYPE.SETTLEMENT,
    referenceId: settlement._id,
    ...nd
  }).session(session);

  for (const row of ledgerRows) {
    await softDeleteWithSession(row, reqUser.userId, session);
  }

  await softDeleteWithSession(settlement, reqUser.userId, session);

  return {
    reversed: true,
    settlementId: settlement._id,
    reversalReason: body?.reversalReason || null
  };
};

/**
 * Reverse proportional clearing for a qty credit (return or amendment).
 * Default referenceType: RETURN_CLEARING_ADJ. Amendments pass AMENDMENT_CLEARING_ADJ.
 */
const postReturnClearingAdjustment = async (session, ctx) => {
  const {
    companyId,
    distributorId,
    deliveryId,
    orderId,
    fraction,
    companyShareTotal,
    distributorShareTotal,
    returnRecordId,
    date,
    referenceType = LEDGER_REFERENCE_TYPE.RETURN_CLEARING_ADJ
  } = ctx;
  const f = Math.min(1, Math.max(0, fraction));
  if (f <= 0) return;

  const isAmendment = referenceType === LEDGER_REFERENCE_TYPE.AMENDMENT_CLEARING_ADJ;
  const label = isAmendment ? 'Amendment' : 'Return';
  const revC = roundPKR(companyShareTotal * f);
  const revD = roundPKR(distributorShareTotal * f);
  const d = date || new Date();
  const meta = { deliveryId, orderId };

  const entries = [];
  if (revC > 0) {
    entries.push(
      buildLedgerBase(
        companyId,
        LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
        distributorId,
        LEDGER_TYPE.CREDIT,
        revC,
        referenceType,
        returnRecordId,
        `${label} — reverse company share clearing`,
        d,
        meta
      )
    );
  }
  if (revD > 0) {
    entries.push(
      buildLedgerBase(
        companyId,
        LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
        distributorId,
        LEDGER_TYPE.DEBIT,
        revD,
        referenceType,
        returnRecordId,
        `${label} — reverse distributor commission clearing`,
        d,
        meta
      )
    );
  }
  if (entries.length) await Ledger.create(entries, { session, ordered: true });
};

/**
 * Business-facing balances: cash collected by distributor still owed to company vs commission company owes distributor.
 * Open = ledger line amount minus settlement allocations in the matching direction.
 */
const getDistributorObligations = async (companyId, distributorId, session = null) => {
  const cid = oid(companyId);
  const did = oid(distributorId);

  const remLines = await Ledger.find({
    companyId: cid,
    entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
    entityId: did,
    referenceType: LEDGER_REFERENCE_TYPE.COLLECTION,
    type: LEDGER_TYPE.DEBIT,
    'meta.portion': LEDGER_COLLECTION_PORTION.REMITTANCE_DUE_TO_COMPANY,
    isDeleted: { $ne: true }
  }).session(session || null);

  let remittanceOpen = 0;
  for (const line of remLines) {
    const allocated = await sumAllocatedForLine(
      companyId,
      distributorId,
      line._id,
      SETTLEMENT_DIRECTION.DISTRIBUTOR_TO_COMPANY,
      session
    );
    remittanceOpen += roundPKR(line.amount - allocated);
  }

  const comLines = await Ledger.find({
    companyId: cid,
    entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
    entityId: did,
    referenceType: LEDGER_REFERENCE_TYPE.COLLECTION,
    type: LEDGER_TYPE.CREDIT,
    'meta.portion': LEDGER_COLLECTION_PORTION.COMMISSION_PAYABLE_TO_DISTRIBUTOR,
    isDeleted: { $ne: true }
  }).session(session || null);

  let commissionOpen = 0;
  for (const line of comLines) {
    const allocated = await sumAllocatedForLine(
      companyId,
      distributorId,
      line._id,
      SETTLEMENT_DIRECTION.COMPANY_TO_DISTRIBUTOR,
      session
    );
    commissionOpen += roundPKR(line.amount - allocated);
  }

  return {
    remittanceDueFromDistributor: roundPKR(Math.max(0, remittanceOpen)),
    commissionPayableByCompanyToDistributor: roundPKR(Math.max(0, commissionOpen))
  };
};

const getDistributorClearingBalance = async (companyId, distributorId) => {
  const result = await Ledger.aggregate([
    {
      $match: {
        companyId: oid(companyId),
        entityId: oid(distributorId),
        entityType: LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING,
        isDeleted: { $ne: true }
      }
    },
    {
      $group: {
        _id: null,
        totalDebit: { $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] } },
        totalCredit: { $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] } }
      }
    }
  ]);
  const row = result[0] || { totalDebit: 0, totalCredit: 0 };
  const net = roundPKR(row.totalDebit - row.totalCredit);
  return {
    totalDebit: roundPKR(row.totalDebit),
    totalCredit: roundPKR(row.totalCredit),
    /** Positive => distributor owes company net; negative => company owes distributor net */
    netDistributorOwesCompany: net
  };
};

module.exports = {
  getCommissionPercent,
  computeLineSnapshot,
  computeOrderLinePreview,
  enrichOrderItemsWithFinancialSnapshot,
  postDeliveryLedgers,
  buildOpenByDeliveryFromLedgerLines,
  resolveReturnCreditDeliveryTargets,
  computePharmacyReceivableState,
  /** Permanent public alias for AR open (aging, collection planning, MR ownership). */
  computePharmacyReceivable: computePharmacyReceivableState,
  computePharmacyReceivableStateLegacy,
  computeOpenTotalsByPharmacy,
  computeOpenTotalsByPharmacyLegacy,
  /** Document-allocation open for a single pharmacy (roadmap: aging buckets). */
  computeOpenFromDocumentAllocations: (...args) =>
    arDocumentOpen.computeOpenFromDocumentAllocations(...args),
  replayPharmacyAllocations: (...args) => arDocumentOpen.replayPharmacyAllocations(...args),
  fifoAllocateCollection,
  createCollection,
  updateCollection,
  reverseCollection,
  createSettlement,
  updateSettlement,
  reverseSettlement,
  postReturnClearingAdjustment,
  getDistributorClearingBalance,
  getDistributorObligations,
  sliceByRatios
};
