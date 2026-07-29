/**
 * Document-allocation AR open engine.
 * Invoice open = DeliveryRecord.pharmacyNetPayable − Σ return allocations − Σ collection allocations − Σ amendment allocations.
 * Does not read Ledger.meta.deliveryId for open balances.
 */
const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Collection = require('../models/Collection');
const DeliveryRecord = require('../models/DeliveryRecord');
const Order = require('../models/Order');
const ReturnRecord = require('../models/ReturnRecord');
const OrderAmendment = require('../models/OrderAmendment');
const { roundPKR } = require('../utils/currency');
const {
  LEDGER_TYPE,
  LEDGER_ENTITY_TYPE,
  LEDGER_REFERENCE_TYPE,
  COLLECTOR_TYPE
} = require('../constants/enums');
const { INVARIANT_EPS, resolveArOpenEngine, AR_OPEN_ENGINE } = require('../constants/arArchitecture');

const OPEN_EPS = 0.001;
const oid = (id) => new mongoose.Types.ObjectId(id);

const safeOid = (id) => {
  if (id == null || id === '') return null;
  const s = String(id);
  if (s === 'null' || s === 'undefined') return null;
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  try {
    return new mongoose.Types.ObjectId(s);
  } catch {
    return null;
  }
};

/**
 * Pure: build open map from delivery invoices + flat allocation lists.
 * @returns {{ openByDelivery: Record<string, number>, pharmacyOpen: number }}
 */
const buildOpenByDeliveryFromDocumentAllocations = ({
  deliveries = [],
  returnAllocations = [],
  collectionAllocations = [],
  amendmentAllocations = []
} = {}) => {
  const openByDelivery = {};
  for (const d of deliveries) {
    if (!d?._id && !d?.deliveryId) continue;
    const id = String(d._id || d.deliveryId);
    const invoice = roundPKR(d.pharmacyNetPayable ?? d.invoiceAmount ?? d.totalAmount ?? 0);
    openByDelivery[id] = invoice;
  }

  const applyList = (list) => {
    for (const a of list || []) {
      if (!a?.deliveryId) continue;
      const id = String(a.deliveryId);
      if (openByDelivery[id] === undefined) continue;
      openByDelivery[id] = roundPKR(openByDelivery[id] - roundPKR(a.amount || 0));
    }
  };
  applyList(returnAllocations);
  applyList(collectionAllocations);
  applyList(amendmentAllocations);

  const pharmacyOpen = roundPKR(
    Object.values(openByDelivery).reduce((s, v) => s + roundPKR(v), 0)
  );
  return { openByDelivery, pharmacyOpen };
};

/**
 * FIFO-apply amount onto preferred delivery ids (positive open only).
 * Mutates openByDelivery. Returns allocations + leftover.
 */
const fifoApplyToOpen = (openByDelivery, amount, deliveryIdsSorted) => {
  let rem = roundPKR(amount);
  const allocations = [];
  for (const id of deliveryIdsSorted) {
    if (rem <= OPEN_EPS) break;
    const cur = openByDelivery[id];
    if (cur == null || cur <= OPEN_EPS) continue;
    const take = roundPKR(Math.min(cur, rem));
    openByDelivery[id] = roundPKR(cur - take);
    rem = roundPKR(rem - take);
    allocations.push({ deliveryId: id, amount: take });
  }
  return { allocations, leftover: rem };
};

/**
 * Order-scoped return application against current open (oldest delivery first).
 * Sub-rupee leftover is forced onto the last target delivery (paisa drift).
 */
const allocateReturnToOrderDeliveries = (openByDelivery, amount, orderDeliveryIdsByDeliveredAt) => {
  const result = fifoApplyToOpen(openByDelivery, amount, orderDeliveryIdsByDeliveredAt);
  if (result.leftover > OPEN_EPS && result.leftover <= 1.001 && orderDeliveryIdsByDeliveredAt.length) {
    const lastId =
      result.allocations.length > 0
        ? result.allocations[result.allocations.length - 1].deliveryId
        : orderDeliveryIdsByDeliveredAt[orderDeliveryIdsByDeliveredAt.length - 1];
    if (openByDelivery[lastId] !== undefined) {
      openByDelivery[lastId] = roundPKR(openByDelivery[lastId] - result.leftover);
    } else {
      openByDelivery[lastId] = roundPKR(-result.leftover);
    }
    const existing = result.allocations.find((a) => String(a.deliveryId) === String(lastId));
    if (existing) existing.amount = roundPKR(existing.amount + result.leftover);
    else result.allocations.push({ deliveryId: lastId, amount: result.leftover });
    result.leftover = 0;
  }
  return result;
};

/**
 * Collection FIFO by deliveredAt among positive opens (optional distributor filter via row list).
 */
const allocateCollectionFifo = (amount, rows) => {
  const sorted = [...rows]
    .filter((r) => roundPKR(r.open) > OPEN_EPS)
    .sort((a, b) => new Date(a.deliveredAt) - new Date(b.deliveredAt));
  let rem = roundPKR(amount);
  const allocations = [];
  for (const row of sorted) {
    if (rem <= OPEN_EPS) break;
    const take = roundPKR(Math.min(row.open, rem));
    if (take <= OPEN_EPS) continue;
    allocations.push({
      deliveryId: row.deliveryId,
      orderId: row.orderId,
      distributorId: row.distributorId,
      amount: take
    });
    rem = roundPKR(rem - take);
  }
  return { allocations, leftover: rem };
};

const loadPharmacyDeliveryContext = async (companyId, pharmacyId, session) => {
  const cid = oid(companyId);
  const pid = oid(pharmacyId);
  const orders = await Order.find({ companyId: cid, pharmacyId: pid, isDeleted: { $ne: true } })
    .select('_id distributorId status')
    .session(session || null)
    .lean();
  const orderIds = orders.map((o) => o._id);
  const orderMap = Object.fromEntries(orders.map((o) => [String(o._id), o]));

  const deliveries =
    orderIds.length === 0
      ? []
      : await DeliveryRecord.find({
          companyId: cid,
          orderId: { $in: orderIds },
          isDeleted: { $ne: true }
        })
          .select(
            '_id orderId pharmacyNetPayable totalAmount deliveredAt companyShareTotal distributorShareTotal invoiceNumber'
          )
          .sort({ deliveredAt: 1, createdAt: 1 })
          .session(session || null)
          .lean();

  // Money SoT for invoice seed: pharmacy ledger DR per delivery (fallback to DeliveryRecord).
  const drLines = await Ledger.find({
    companyId: cid,
    entityId: pid,
    entityType: LEDGER_ENTITY_TYPE.PHARMACY,
    type: LEDGER_TYPE.DEBIT,
    referenceType: { $in: [LEDGER_REFERENCE_TYPE.DELIVERY, LEDGER_REFERENCE_TYPE.ORDER] },
    isDeleted: { $ne: true }
  })
    .select('referenceId amount')
    .session(session || null)
    .lean();

  const ledgerDrByDelivery = {};
  for (const line of drLines) {
    if (!line?.referenceId) continue;
    const id = String(line.referenceId);
    ledgerDrByDelivery[id] = roundPKR((ledgerDrByDelivery[id] || 0) + roundPKR(line.amount || 0));
  }

  const deliveriesWithInvoice = deliveries.map((d) => {
    const id = String(d._id);
    const fromLedger = ledgerDrByDelivery[id];
    const invoiceAmount =
      fromLedger != null
        ? fromLedger
        : roundPKR(d.pharmacyNetPayable ?? d.totalAmount ?? 0);
    return { ...d, invoiceAmount, pharmacyNetPayable: invoiceAmount };
  });

  return { orders, orderIds, orderMap, deliveries: deliveriesWithInvoice, ledgerDrByDelivery };
};

const flattenReturnAllocations = (returns) => {
  const out = [];
  for (const r of returns || []) {
    for (const a of r.allocations || []) {
      if (!a?.deliveryId) continue;
      out.push({
        deliveryId: a.deliveryId,
        amount: roundPKR(a.amount || 0),
        returnId: r._id
      });
    }
  }
  return out;
};

const flattenAmendmentAllocations = (amendments) => {
  const out = [];
  for (const amd of amendments || []) {
    for (const a of amd.allocations || []) {
      if (!a?.deliveryId) continue;
      out.push({
        deliveryId: a.deliveryId,
        amount: roundPKR(a.amount || 0),
        amendmentId: amd._id
      });
    }
  }
  return out;
};

/**
 * Apply amendment credits to open map from OrderAmendment.allocations.
 */
const applyAmendmentsToOpen = (openByDelivery, amendments) => {
  for (const amd of amendments || []) {
    for (const a of amd.allocations || []) {
      if (!a?.deliveryId) continue;
      const id = String(a.deliveryId);
      if (openByDelivery[id] === undefined) continue;
      openByDelivery[id] = roundPKR(openByDelivery[id] - roundPKR(a.amount || 0));
    }
  }
};

/**
 * Apply return credits to open map. Prefer ReturnRecord.allocations;
 * optional legacy fallback: order-scoped FIFO when allocations empty (AR_LEGACY_RETURN_ALLOC_FALLBACK≠0).
 */
const applyReturnsToOpen = (openByDelivery, returns, delsByOrder) => {
  const allowFallback = process.env.AR_LEGACY_RETURN_ALLOC_FALLBACK !== '0';
  for (const r of returns || []) {
    const allocs = r.allocations || [];
    if (allocs.length) {
      for (const a of allocs) {
        if (!a?.deliveryId) continue;
        const id = String(a.deliveryId);
        if (openByDelivery[id] === undefined) continue;
        openByDelivery[id] = roundPKR(openByDelivery[id] - roundPKR(a.amount || 0));
      }
      continue;
    }
    if (!allowFallback) continue;
    const targets = delsByOrder.get(String(r.orderId)) || [];
    allocateReturnToOrderDeliveries(openByDelivery, roundPKR(r.totalAmount || 0), targets);
  }
};

const flattenCollectionAllocations = (collections) => {
  const out = [];
  for (const c of collections || []) {
    for (const a of c.allocations || []) {
      if (!a?.deliveryId) continue;
      out.push({
        deliveryId: a.deliveryId,
        amount: roundPKR(a.amount || 0),
        collectionId: c._id
      });
    }
  }
  return out;
};

const computeLedgerNet = async (companyId, pharmacyId, session) => {
  const q = {
    companyId: oid(companyId),
    entityId: oid(pharmacyId),
    entityType: LEDGER_ENTITY_TYPE.PHARMACY,
    isDeleted: { $ne: true }
  };
  const [dr, cr] = await Promise.all([
    Ledger.aggregate([
      {
        $match: {
          ...q,
          type: LEDGER_TYPE.DEBIT,
          referenceType: { $in: [LEDGER_REFERENCE_TYPE.DELIVERY, LEDGER_REFERENCE_TYPE.ORDER] }
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).session(session || null),
    Ledger.aggregate([
      {
        $match: {
          ...q,
          type: LEDGER_TYPE.CREDIT,
          referenceType: {
            $in: [
              LEDGER_REFERENCE_TYPE.COLLECTION,
              LEDGER_REFERENCE_TYPE.PAYMENT,
              LEDGER_REFERENCE_TYPE.RETURN,
              LEDGER_REFERENCE_TYPE.AMENDMENT
            ]
          }
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).session(session || null)
  ]);
  return roundPKR((dr[0]?.total || 0) - (cr[0]?.total || 0));
};

/**
 * Load document allocations and compute open for one pharmacy.
 */
const computeOpenFromDocumentAllocations = async (companyId, pharmacyId, session) => {
  const { orderIds, orderMap, deliveries } = await loadPharmacyDeliveryContext(
    companyId,
    pharmacyId,
    session
  );

  const returns =
    orderIds.length === 0
      ? []
      : await ReturnRecord.find({
          companyId: oid(companyId),
          orderId: { $in: orderIds },
          isDeleted: { $ne: true }
        })
          .select('_id orderId totalAmount allocations returnedAt createdAt')
          .session(session || null)
          .lean();

  const amendments =
    orderIds.length === 0
      ? []
      : await OrderAmendment.find({
          companyId: oid(companyId),
          orderId: { $in: orderIds },
          isDeleted: { $ne: true }
        })
          .select('_id orderId totalAmount allocations amendedAt createdAt')
          .session(session || null)
          .lean();

  const collections = await Collection.find({
    companyId: oid(companyId),
    pharmacyId: oid(pharmacyId),
    isDeleted: { $ne: true }
  })
    .select('_id amount allocations collectorType distributorId date createdAt')
    .session(session || null)
    .lean();

  const delsByOrder = new Map();
  for (const d of deliveries) {
    const key = String(d.orderId);
    if (!delsByOrder.has(key)) delsByOrder.set(key, []);
    delsByOrder.get(key).push(String(d._id));
  }

  const openByDelivery = {};
  for (const d of deliveries) {
    openByDelivery[String(d._id)] = roundPKR(d.pharmacyNetPayable ?? d.totalAmount ?? 0);
  }
  applyReturnsToOpen(openByDelivery, returns, delsByOrder);
  applyAmendmentsToOpen(openByDelivery, amendments);
  const collectionAllocations = flattenCollectionAllocations(collections);
  for (const a of collectionAllocations) {
    const id = String(a.deliveryId);
    if (openByDelivery[id] === undefined) continue;
    openByDelivery[id] = roundPKR(openByDelivery[id] - roundPKR(a.amount || 0));
  }
  const pharmacyOpen = roundPKR(
    Object.values(openByDelivery).reduce((s, v) => s + roundPKR(v), 0)
  );

  const rows = deliveries.map((d) => {
    const id = String(d._id);
    const o = orderMap[String(d.orderId)];
    const open = roundPKR(openByDelivery[id] ?? 0);
    return {
      deliveryId: d._id,
      orderId: d.orderId,
      distributorId: o?.distributorId,
      pharmacyNetPayable: roundPKR(d.pharmacyNetPayable ?? d.totalAmount),
      companyShareTotal: roundPKR(d.companyShareTotal ?? 0),
      distributorShareTotal: roundPKR(d.distributorShareTotal ?? 0),
      deliveredAt: d.deliveredAt,
      invoiceNumber: d.invoiceNumber || null,
      open: roundPKR(Math.max(0, open)),
      rawOpen: open
    };
  });

  const totalOpen = roundPKR(rows.reduce((s, r) => s + Math.max(0, r.open), 0));
  const ledgerNet = await computeLedgerNet(companyId, pharmacyId, session);

  return {
    rows,
    totalOpen,
    pharmacyOpen,
    openByDelivery,
    ledgerNet,
    returns,
    amendments,
    collections,
    deliveries,
    invariants: {
      pharmacyOpenEqualsLedgerNet: Math.abs(pharmacyOpen - ledgerNet) <= INVARIANT_EPS,
      noNegativeOpen: Object.values(openByDelivery).every((v) => v >= -INVARIANT_EPS)
    }
  };
};

/**
 * Chronological replay that proposes ReturnRecord.allocations + Collection.allocations.
 * Does not mutate DB unless caller applies results.
 */
const replayPharmacyAllocations = async (companyId, pharmacyId, session) => {
  const { orderMap, deliveries } = await loadPharmacyDeliveryContext(companyId, pharmacyId, session);
  const deliveryById = Object.fromEntries(deliveries.map((d) => [String(d._id), d]));

  const delsByOrder = new Map();
  for (const d of deliveries) {
    const key = String(d.orderId);
    if (!delsByOrder.has(key)) delsByOrder.set(key, []);
    delsByOrder.get(key).push(String(d._id));
  }

  const orderIds = [...new Set(deliveries.map((d) => String(d.orderId)))];
  const returns =
    orderIds.length === 0
      ? []
      : await ReturnRecord.find({
          companyId: oid(companyId),
          orderId: { $in: orderIds.map((id) => oid(id)) },
          isDeleted: { $ne: true }
        })
          .session(session || null)
          .lean();

  const collections = await Collection.find({
    companyId: oid(companyId),
    pharmacyId: oid(pharmacyId),
    isDeleted: { $ne: true }
  })
    .session(session || null)
    .lean();

  const open = {};
  for (const d of deliveries) {
    open[String(d._id)] = roundPKR(d.pharmacyNetPayable ?? d.totalAmount ?? 0);
  }

  const events = [];
  for (const r of returns) {
    events.push({
      kind: 'RETURN',
      t: new Date(r.returnedAt || r.createdAt || 0).getTime(),
      id: String(r._id),
      doc: r
    });
  }
  for (const c of collections) {
    events.push({
      kind: 'COLLECTION',
      t: new Date(c.date || c.createdAt || 0).getTime(),
      id: String(c._id),
      doc: c
    });
  }

  const amendments =
    orderIds.length === 0
      ? []
      : await OrderAmendment.find({
          companyId: oid(companyId),
          orderId: { $in: orderIds.map((id) => oid(id)) },
          isDeleted: { $ne: true }
        })
          .session(session || null)
          .lean();

  for (const amd of amendments) {
    events.push({
      kind: 'AMENDMENT',
      t: new Date(amd.amendedAt || amd.createdAt || 0).getTime(),
      id: String(amd._id),
      doc: amd
    });
  }
  events.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));

  const returnPlans = [];
  const collectionPlans = [];
  const exceptions = [];

  for (const ev of events) {
    if (ev.kind === 'AMENDMENT') {
      const amd = ev.doc;
      for (const a of amd.allocations || []) {
        if (!a?.deliveryId) continue;
        const id = String(a.deliveryId);
        if (open[id] === undefined) continue;
        open[id] = roundPKR(open[id] - roundPKR(a.amount || 0));
      }
      continue;
    }

    if (ev.kind === 'RETURN') {
      const r = ev.doc;
      const amount = roundPKR(r.totalAmount || 0);
      const targets = delsByOrder.get(String(r.orderId)) || [];
      const { allocations, leftover } = allocateReturnToOrderDeliveries(open, amount, targets);
      if (leftover > OPEN_EPS) {
        exceptions.push({
          type: 'RETURN_LEFTOVER',
          returnId: String(r._id),
          amount,
          leftover
        });
      }
      returnPlans.push({
        returnId: r._id,
        before: (r.allocations || []).map((a) => ({
          deliveryId: String(a.deliveryId),
          amount: roundPKR(a.amount)
        })),
        after: allocations.map((a) => ({
          deliveryId: a.deliveryId,
          amount: a.amount
        })),
        leftover
      });
      continue;
    }

    if (ev.kind === 'COLLECTION') {
      const c = ev.doc;
      const amount = roundPKR(c.amount || 0);
      let rows = Object.keys(open)
        .filter((id) => (open[id] || 0) > OPEN_EPS)
        .map((id) => {
          const d = deliveryById[id];
          const o = d ? orderMap[String(d.orderId)] : null;
          return {
            deliveryId: d?._id || oid(id),
            orderId: d?.orderId,
            distributorId: o?.distributorId,
            deliveredAt: d?.deliveredAt,
            open: open[id]
          };
        });

      if (c.collectorType === COLLECTOR_TYPE.DISTRIBUTOR && c.distributorId) {
        const did = String(c.distributorId);
        rows = rows.filter((row) => row.distributorId && String(row.distributorId) === did);
      }

      const { allocations, leftover } = allocateCollectionFifo(amount, rows);
      for (const a of allocations) {
        const id = String(a.deliveryId);
        open[id] = roundPKR((open[id] || 0) - a.amount);
      }
      if (leftover > OPEN_EPS) {
        exceptions.push({
          type: 'COLLECTION_CANNOT_FULLY_ALLOCATE',
          collectionId: String(c._id),
          amount,
          leftover
        });
      }
      collectionPlans.push({
        collectionId: c._id,
        before: (c.allocations || []).map((a) => ({
          deliveryId: String(a.deliveryId),
          orderId: a.orderId ? String(a.orderId) : null,
          distributorId: a.distributorId ? String(a.distributorId) : null,
          amount: roundPKR(a.amount)
        })),
        after: allocations.map((a) => ({
          deliveryId: String(a.deliveryId),
          orderId: a.orderId ? String(a.orderId) : null,
          distributorId: a.distributorId ? String(a.distributorId) : null,
          amount: a.amount
        })),
        leftover
      });
    }
  }

  const { pharmacyOpen } = buildOpenByDeliveryFromDocumentAllocations({
    deliveries,
    returnAllocations: returnPlans.flatMap((p) =>
      p.after.map((a) => ({ deliveryId: a.deliveryId, amount: a.amount }))
    ),
    collectionAllocations: collectionPlans.flatMap((p) =>
      p.after.map((a) => ({ deliveryId: a.deliveryId, amount: a.amount }))
    ),
    amendmentAllocations: flattenAmendmentAllocations(amendments)
  });
  const ledgerNet = await computeLedgerNet(companyId, pharmacyId, session);

  return {
    pharmacyId: String(pharmacyId),
    returnPlans,
    collectionPlans,
    exceptions,
    pharmacyOpen,
    ledgerNet,
    invariantsOk:
      exceptions.length === 0 &&
      Math.abs(pharmacyOpen - ledgerNet) <= INVARIANT_EPS &&
      Object.values(open).every((v) => v >= -INVARIANT_EPS)
  };
};

/**
 * Bulk open totals for many pharmacies (document engine).
 * @returns {Promise<Map<string, number>>}
 */
const computeOpenTotalsByPharmacyFromDocuments = async (companyId, pharmacyIds) => {
  const result = new Map();
  const ids = [...new Set((pharmacyIds || []).map((id) => safeOid(id)).filter(Boolean))];
  for (const pid of ids) result.set(String(pid), 0);
  if (!ids.length) return result;

  // Sequential per pharmacy keeps memory bounded; company scale is modest.
  for (const pid of ids) {
    const state = await computeOpenFromDocumentAllocations(companyId, pid, null);
    result.set(String(pid), state.totalOpen);
  }
  return result;
};

const maybeLogShadowDivergence = (companyId, pharmacyId, documentState, legacyTotalOpen) => {
  if (resolveArOpenEngine() !== AR_OPEN_ENGINE.SHADOW) return;
  const doc = roundPKR(documentState.totalOpen);
  const leg = roundPKR(legacyTotalOpen);
  if (Math.abs(doc - leg) > INVARIANT_EPS) {
    // eslint-disable-next-line no-console
    console.warn(
      `[AR_OPEN_ENGINE=shadow] pharmacy=${pharmacyId} company=${companyId} documentOpen=${doc} legacyOpen=${leg} ledgerNet=${documentState.ledgerNet}`
    );
  }
};

module.exports = {
  OPEN_EPS,
  buildOpenByDeliveryFromDocumentAllocations,
  allocateReturnToOrderDeliveries,
  allocateCollectionFifo,
  computeOpenFromDocumentAllocations,
  computeOpenTotalsByPharmacyFromDocuments,
  replayPharmacyAllocations,
  computeLedgerNet,
  flattenReturnAllocations,
  flattenAmendmentAllocations,
  flattenCollectionAllocations,
  applyReturnsToOpen,
  applyAmendmentsToOpen,
  maybeLogShadowDivergence
};
