const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Collection = require('../models/Collection');
const Settlement = require('../models/Settlement');
const SettlementAllocation = require('../models/SettlementAllocation');
const DeliveryRecord = require('../models/DeliveryRecord');
const Order = require('../models/Order');
const Distributor = require('../models/Distributor');
const ApiError = require('../utils/ApiError');
const { roundPKR } = require('../utils/currency');
const {
  LEDGER_TYPE,
  LEDGER_ENTITY_TYPE,
  LEDGER_REFERENCE_TYPE,
  COLLECTOR_TYPE,
  SETTLEMENT_DIRECTION,
  LEDGER_COLLECTION_PORTION
} = require('../constants/enums');

const oid = (id) => new mongoose.Types.ObjectId(id);

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
  const snap = computeLineSnapshot(orderItem, paidQty, distributor);
  const pharmacyDiscountAmount = roundPKR(snap.tpLineTotal - snap.linePharmacyNet);
  const bonusQty = Number(orderItem.bonusQuantity) || 0;
  const physicalQty = paidQty + bonusQty;
  const inventoryCostAmount = roundPKR((orderItem.castingAtTime || 0) * physicalQty);
  return {
    grossAmount: snap.tpLineTotal,
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
 * Load pharmacy DR lines (per delivery) and apply CR chronologically (FIFO for unallocated).
 */
const computePharmacyReceivableState = async (companyId, pharmacyId, session) => {
  const q = { companyId: oid(companyId), entityId: oid(pharmacyId), entityType: LEDGER_ENTITY_TYPE.PHARMACY, isDeleted: { $ne: true } };
  // Sequential reads: MongoDB transactions do not allow concurrent operations on the same session.
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
    referenceType: { $in: [LEDGER_REFERENCE_TYPE.COLLECTION, LEDGER_REFERENCE_TYPE.PAYMENT, LEDGER_REFERENCE_TYPE.RETURN] }
  })
    .session(session || null)
    .sort({ date: 1, createdAt: 1 });

  const openByDelivery = {};
  for (const dr of drLines) {
    const id = dr.referenceId.toString();
    openByDelivery[id] = roundPKR((openByDelivery[id] || 0) + dr.amount);
  }

  for (const cr of crLines) {
    const amt = roundPKR(cr.amount);
    if (cr.meta?.deliveryId) {
      const id = cr.meta.deliveryId.toString();
      if (openByDelivery[id] !== undefined) {
        openByDelivery[id] = roundPKR(openByDelivery[id] - amt);
      }
    } else {
      let remaining = amt;
      const deliveryIds = Object.keys(openByDelivery).sort();
      for (const id of deliveryIds) {
        if (remaining <= 0) break;
        const cur = openByDelivery[id];
        if (cur <= 0) continue;
        const take = roundPKR(Math.min(cur, remaining));
        openByDelivery[id] = roundPKR(cur - take);
        remaining = roundPKR(remaining - take);
      }
    }
  }

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
    .select('distributorId pharmacyId')
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
      return {
        deliveryId: d._id,
        orderId: d.orderId,
        distributorId: o?.distributorId,
        pharmacyNetPayable: roundPKR(d.pharmacyNetPayable ?? d.totalAmount),
        companyShareTotal: roundPKR(d.companyShareTotal ?? 0),
        distributorShareTotal: roundPKR(d.distributorShareTotal ?? 0),
        deliveredAt: d.deliveredAt,
        open: roundPKR(openByDelivery[id] ?? 0)
      };
    });

  const totalOpen = roundPKR(rows.reduce((s, r) => s + Math.max(0, r.open), 0));
  return { rows, totalOpen, openByDelivery };
};

function deliveryIdsFromOpen(openByDelivery) {
  return Object.keys(openByDelivery).map((id) => oid(id));
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
    referenceNumber,
    date,
    notes
  } = data;

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

  return collection;
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
  const { distributorId, direction, amount, paymentMethod, referenceNumber, date, notes, isNetSettlement, grossDistributorToCompany, grossCompanyToDistributor } = data;

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
 * Reverse proportional clearing for a return (RETURN_CLEARING_ADJ).
 */
const postReturnClearingAdjustment = async (session, ctx) => {
  const { companyId, distributorId, deliveryId, orderId, fraction, companyShareTotal, distributorShareTotal, returnRecordId, date } = ctx;
  const f = Math.min(1, Math.max(0, fraction));
  if (f <= 0) return;

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
        LEDGER_REFERENCE_TYPE.RETURN_CLEARING_ADJ,
        returnRecordId,
        'Return — reverse company share clearing',
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
        LEDGER_REFERENCE_TYPE.RETURN_CLEARING_ADJ,
        returnRecordId,
        'Return — reverse distributor commission clearing',
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
  computePharmacyReceivableState,
  fifoAllocateCollection,
  createCollection,
  createSettlement,
  postReturnClearingAdjustment,
  getDistributorClearingBalance,
  getDistributorObligations,
  sliceByRatios
};
