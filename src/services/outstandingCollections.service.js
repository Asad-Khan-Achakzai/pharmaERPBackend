/**
 * Outstanding Collections — role-scoped operational receivables for Payments & Collections.
 * Uses document-allocation open (Collection.allocations + ReturnRecord.allocations).
 *
 * Future extension points (consume computePharmacyReceivable / computeOpenFromDocumentAllocations):
 * - Pharmacy→MR ownership: extend resolveOutstandingRepId / visibility helpers; keep HTTP contract.
 * - Aging buckets, priority, reminders, analytics, visit/route planning: additive fields / groupBy values.
 */
const mongoose = require('mongoose');
const DeliveryRecord = require('../models/DeliveryRecord');
const Order = require('../models/Order');
const Pharmacy = require('../models/Pharmacy');
const User = require('../models/User');
const Territory = require('../models/Territory');
const Collection = require('../models/Collection');
const ApiError = require('../utils/ApiError');
const { roundPKR } = require('../utils/currency');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar } = require('../utils/listQuery');
const { TERRITORY_KIND } = require('../constants/enums');
const financialService = require('./financial.service');
const { resolveOrderVisibleMedicalRepIds } = require('../utils/orderScope.util');

const oid = (id) => new mongoose.Types.ObjectId(id);
const nd = { $ne: true };
const OPEN_EPS = 0.001;

const GROUP_BY = {
  pharmacy: 'pharmacy',
  medicalRep: 'medicalRep',
  area: 'area',
  zone: 'zone',
  invoice: 'invoice'
};

const PAYMENT_STATUS = {
  UNPAID: 'UNPAID',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID'
};

const deriveInvoicePaymentStatus = (invoiceAmount, outstanding) => {
  if (invoiceAmount <= OPEN_EPS) return null;
  if (outstanding <= OPEN_EPS) return PAYMENT_STATUS.PAID;
  if (outstanding + OPEN_EPS >= invoiceAmount) return PAYMENT_STATUS.UNPAID;
  return PAYMENT_STATUS.PARTIALLY_PAID;
};

/**
 * Attribution seam — today order.medicalRepId only.
 * Future pharmacy ownership can extend here without changing HTTP contracts.
 */
const resolveOutstandingRepId = ({ order }) => {
  if (!order?.medicalRepId) return null;
  return order.medicalRepId._id || order.medicalRepId;
};

const areaZoneFromTerritory = (territory) => {
  if (!territory) return { areaId: null, zoneId: null };
  const parts = String(territory.materializedPath || '')
    .split('/')
    .filter(Boolean);
  const kind = territory.kind;
  if (kind === TERRITORY_KIND.ZONE) {
    return { zoneId: String(territory._id), areaId: null };
  }
  if (kind === TERRITORY_KIND.AREA) {
    return { zoneId: parts[0] || null, areaId: String(territory._id) };
  }
  return { zoneId: parts[0] || null, areaId: parts[1] || null };
};

const assertRepInScope = (visibleRepIds, medicalRepId) => {
  if (visibleRepIds === null) return;
  const ok = visibleRepIds.some((id) => String(id) === String(medicalRepId));
  if (!ok) throw new ApiError(403, 'You cannot view outstanding for this medical rep');
};

/**
 * Build scoped open invoice rows (one per delivery with open > 0).
 * Uses document-allocation open engine (Collection + ReturnRecord allocations).
 */
const loadScopedOpenRows = async (companyId, visibleRepIds, { medicalRepId, pharmacyId } = {}) => {
  const cid = oid(companyId);

  let effectiveRepIds = visibleRepIds;
  if (medicalRepId) {
    if (!mongoose.Types.ObjectId.isValid(medicalRepId)) {
      throw new ApiError(400, 'Invalid medicalRepId');
    }
    assertRepInScope(visibleRepIds, medicalRepId);
    effectiveRepIds = [oid(medicalRepId)];
  }

  if (effectiveRepIds !== null && effectiveRepIds.length === 0) {
    return [];
  }

  const orderFilter = {
    companyId: cid,
    isDeleted: nd
  };
  if (effectiveRepIds !== null) {
    orderFilter.medicalRepId = { $in: effectiveRepIds };
  }
  if (pharmacyId) {
    if (!mongoose.Types.ObjectId.isValid(pharmacyId)) {
      throw new ApiError(400, 'Invalid pharmacyId');
    }
    orderFilter.pharmacyId = oid(pharmacyId);
  }

  const pharmacyIds = await Order.distinct('pharmacyId', orderFilter);
  if (!pharmacyIds.length) return [];

  const openByDelivery = {};

  for (const pid of pharmacyIds) {
    const state = await financialService.computePharmacyReceivableState(companyId, pid, null);
    for (const row of state.rows || []) {
      const id = String(row.deliveryId);
      const open = roundPKR(row.open || 0);
      if (open <= OPEN_EPS) continue;
      openByDelivery[id] = open;
    }
  }

  const openDeliveryIds = Object.keys(openByDelivery);
  if (!openDeliveryIds.length) return [];

  const deliveries = await DeliveryRecord.find({
    companyId: cid,
    _id: { $in: openDeliveryIds.map((id) => new mongoose.Types.ObjectId(id)) },
    isDeleted: nd
  })
    .select(
      'orderId invoiceNumber pharmacyNetPayable totalAmount invoiceGrandTotal taxTotal goodsNetPayable deliveredAt deliveredBy companyShareTotal distributorShareTotal'
    )
    .lean();

  const orderIds = [
    ...new Set(deliveries.map((d) => String(d.orderId)).filter((id) => mongoose.Types.ObjectId.isValid(id)))
  ];
  if (!orderIds.length) return [];

  const orders = await Order.find({
    _id: { $in: orderIds.map((id) => new mongoose.Types.ObjectId(id)) },
    companyId: cid,
    isDeleted: nd
  })
    .select('medicalRepId pharmacyId orderNumber distributorId status')
    .lean();

  const orderMap = new Map(orders.map((o) => [String(o._id), o]));
  const allowedRepSet =
    effectiveRepIds === null ? null : new Set(effectiveRepIds.map((id) => String(id)));

  const rows = [];
  for (const d of deliveries) {
    const order = orderMap.get(String(d.orderId));
    if (!order) continue;
    const repId = resolveOutstandingRepId({ order });
    if (!repId) continue;
    if (allowedRepSet && !allowedRepSet.has(String(repId))) continue;
    if (pharmacyId && String(order.pharmacyId) !== String(pharmacyId)) continue;

    const open = roundPKR(Math.max(0, openByDelivery[String(d._id)] || 0));
    if (open <= OPEN_EPS) continue;

    const { resolveInvoiceGrandTotal } = require('../utils/invoiceTotals');
    const invoiceAmount = resolveInvoiceGrandTotal(d);
    rows.push({
      deliveryId: d._id,
      invoiceNumber: d.invoiceNumber || null,
      orderId: d.orderId,
      orderNumber: order.orderNumber || null,
      pharmacyId: order.pharmacyId,
      medicalRepId: repId,
      distributorId: order.distributorId || null,
      deliveredAt: d.deliveredAt || null,
      dueDate: null,
      invoiceAmount,
      open,
      paymentStatus: deriveInvoicePaymentStatus(invoiceAmount, open)
    });
  }

  return rows;
};

const loadTerritoryContextForReps = async (companyId, repIds) => {
  const users = await User.find({
    companyId: oid(companyId),
    _id: { $in: repIds.map(oid) },
    isDeleted: nd
  })
    .select('name territoryId')
    .lean();

  const territoryIds = [
    ...new Set(users.map((u) => (u.territoryId ? String(u.territoryId) : null)).filter(Boolean))
  ];
  const territories = territoryIds.length
    ? await Territory.find({
        companyId: oid(companyId),
        _id: { $in: territoryIds.map(oid) },
        isDeleted: nd
      })
        .select('name kind materializedPath parentId')
        .lean()
    : [];
  const territoryMap = new Map(territories.map((t) => [String(t._id), t]));

  const areaZoneIds = new Set();
  const userCtx = new Map();
  for (const u of users) {
    const t = u.territoryId ? territoryMap.get(String(u.territoryId)) : null;
    const { areaId, zoneId } = areaZoneFromTerritory(t);
    if (areaId) areaZoneIds.add(areaId);
    if (zoneId) areaZoneIds.add(zoneId);
    userCtx.set(String(u._id), {
      name: u.name || 'Medical Rep',
      areaId,
      zoneId
    });
  }

  const namedTerritories = areaZoneIds.size
    ? await Territory.find({
        companyId: oid(companyId),
        _id: { $in: [...areaZoneIds].map(oid) },
        isDeleted: nd
      })
        .select('name kind')
        .lean()
    : [];
  const nameByTerritory = new Map(namedTerritories.map((t) => [String(t._id), t.name]));

  return { userCtx, nameByTerritory };
};

const enrichOpenRowsWithLabels = async (companyId, openRows) => {
  if (!openRows.length) {
    return { rows: [], pharmacyMap: new Map(), userCtx: new Map(), nameByTerritory: new Map() };
  }

  const pharmacyIds = [...new Set(openRows.map((r) => String(r.pharmacyId)))];
  const repIds = [...new Set(openRows.map((r) => String(r.medicalRepId)))];

  const [pharmacies, territoryCtx] = await Promise.all([
    Pharmacy.find({
      companyId: oid(companyId),
      _id: { $in: pharmacyIds.map(oid) },
      isDeleted: nd
    })
      .select('name city phone isActive')
      .lean(),
    loadTerritoryContextForReps(companyId, repIds)
  ]);

  const pharmacyMap = new Map(pharmacies.map((p) => [String(p._id), p]));
  const { userCtx, nameByTerritory } = territoryCtx;

  const rows = openRows.map((r) => {
    const pharmacy = pharmacyMap.get(String(r.pharmacyId));
    const rep = userCtx.get(String(r.medicalRepId));
    return {
      ...r,
      pharmacyName: pharmacy?.name || 'Pharmacy',
      pharmacyCity: pharmacy?.city || null,
      pharmacyPhone: pharmacy?.phone || null,
      medicalRepName: rep?.name || 'Medical Rep',
      areaId: rep?.areaId || null,
      zoneId: rep?.zoneId || null,
      areaName: rep?.areaId ? nameByTerritory.get(rep.areaId) || 'Area' : null,
      zoneName: rep?.zoneId ? nameByTerritory.get(rep.zoneId) || 'Zone' : null
    };
  });

  return { rows, pharmacyMap, userCtx, nameByTerritory };
};

const aggregateRows = (enrichedRows, groupBy) => {
  const map = new Map();

  const ensure = (key, seed) => {
    if (!map.has(key)) {
      map.set(key, {
        key,
        label: seed.label,
        outstanding: 0,
        invoiceCount: 0,
        pharmacyIds: new Set(),
        medicalRepIds: new Set(),
        medicalRepId: seed.medicalRepId ?? null,
        pharmacyId: seed.pharmacyId ?? null,
        areaId: seed.areaId ?? null,
        zoneId: seed.zoneId ?? null,
        meta: seed.meta || {}
      });
    }
    return map.get(key);
  };

  for (const r of enrichedRows) {
    let bucket;
    if (groupBy === GROUP_BY.pharmacy) {
      bucket = ensure(String(r.pharmacyId), {
        label: r.pharmacyName,
        pharmacyId: r.pharmacyId,
        meta: { city: r.pharmacyCity, phone: r.pharmacyPhone }
      });
    } else if (groupBy === GROUP_BY.medicalRep) {
      bucket = ensure(String(r.medicalRepId), {
        label: r.medicalRepName,
        medicalRepId: r.medicalRepId,
        areaId: r.areaId,
        zoneId: r.zoneId,
        meta: { areaName: r.areaName, zoneName: r.zoneName }
      });
    } else if (groupBy === GROUP_BY.area) {
      const key = r.areaId || `unassigned:${r.medicalRepId}`;
      bucket = ensure(key, {
        label: r.areaName || 'Unassigned area',
        areaId: r.areaId,
        zoneId: r.zoneId,
        meta: { zoneName: r.zoneName }
      });
    } else if (groupBy === GROUP_BY.zone) {
      const key = r.zoneId || `unassigned:${r.medicalRepId}`;
      bucket = ensure(key, {
        label: r.zoneName || 'Unassigned zone',
        zoneId: r.zoneId,
        meta: {}
      });
    } else if (groupBy === GROUP_BY.invoice) {
      bucket = ensure(String(r.deliveryId), {
        label: r.invoiceNumber || r.orderNumber || String(r.deliveryId),
        pharmacyId: r.pharmacyId,
        medicalRepId: r.medicalRepId,
        meta: {
          orderId: r.orderId,
          orderNumber: r.orderNumber,
          invoiceNumber: r.invoiceNumber,
          deliveredAt: r.deliveredAt,
          dueDate: r.dueDate,
          invoiceAmount: r.invoiceAmount,
          paymentStatus: r.paymentStatus,
          medicalRepName: r.medicalRepName
        }
      });
    } else {
      throw new ApiError(400, `Unsupported groupBy: ${groupBy}`);
    }

    bucket.outstanding = roundPKR(bucket.outstanding + r.open);
    bucket.invoiceCount += 1;
    bucket.pharmacyIds.add(String(r.pharmacyId));
    bucket.medicalRepIds.add(String(r.medicalRepId));
  }

  return [...map.values()].map((b) => ({
    key: b.key,
    label: b.label,
    outstanding: b.outstanding,
    invoiceCount: b.invoiceCount,
    pharmacyCount: b.pharmacyIds.size,
    medicalRepCount: b.medicalRepIds.size,
    medicalRepId: b.medicalRepId,
    pharmacyId: b.pharmacyId,
    areaId: b.areaId,
    zoneId: b.zoneId,
    meta: b.meta
  }));
};

const computeTotals = (enrichedRows) => {
  const pharmacyIds = new Set();
  const medicalRepIds = new Set();
  let outstanding = 0;
  for (const r of enrichedRows) {
    outstanding = roundPKR(outstanding + r.open);
    pharmacyIds.add(String(r.pharmacyId));
    medicalRepIds.add(String(r.medicalRepId));
  }
  return {
    outstanding,
    pharmacyCount: pharmacyIds.size,
    invoiceCount: enrichedRows.length,
    medicalRepCount: medicalRepIds.size
  };
};

const filterEnrichedRows = (rows, query) => {
  let out = rows;
  const areaId = qScalar(query.areaId);
  const zoneId = qScalar(query.zoneId);
  if (areaId) out = out.filter((r) => String(r.areaId || '') === String(areaId));
  if (zoneId) out = out.filter((r) => String(r.zoneId || '') === String(zoneId));

  const search = qScalar(query.search);
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    const groupBy = qScalar(query.groupBy) || GROUP_BY.pharmacy;
    out = out.filter((r) => {
      if (groupBy === GROUP_BY.medicalRep) return rx.test(r.medicalRepName || '');
      if (groupBy === GROUP_BY.area) return rx.test(r.areaName || '') || rx.test(r.medicalRepName || '');
      if (groupBy === GROUP_BY.zone) return rx.test(r.zoneName || '') || rx.test(r.medicalRepName || '');
      if (groupBy === GROUP_BY.invoice) {
        return (
          rx.test(r.invoiceNumber || '') ||
          rx.test(r.orderNumber || '') ||
          rx.test(r.pharmacyName || '')
        );
      }
      return rx.test(r.pharmacyName || '') || rx.test(r.pharmacyCity || '');
    });
  }
  return out;
};

const sortAggregated = (rows, sortBy, sortOrder) => {
  const dir = sortOrder === 'asc' ? 1 : -1;
  const key = sortBy || 'outstanding';
  return [...rows].sort((a, b) => {
    if (key === 'label') {
      return String(a.label).localeCompare(String(b.label)) * dir;
    }
    if (key === 'invoiceCount') return (a.invoiceCount - b.invoiceCount) * dir;
    return (a.outstanding - b.outstanding) * dir;
  });
};

/**
 * GET /collections/outstanding
 */
const list = async (companyId, reqUser, query = {}) => {
  const groupBy = qScalar(query.groupBy) || GROUP_BY.pharmacy;
  if (!Object.values(GROUP_BY).includes(groupBy)) {
    throw new ApiError(400, `groupBy must be one of: ${Object.values(GROUP_BY).join(', ')}`);
  }

  const visibleRepIds = await resolveOrderVisibleMedicalRepIds(companyId, reqUser);
  const openRows = await loadScopedOpenRows(companyId, visibleRepIds, {
    medicalRepId: qScalar(query.medicalRepId) || undefined,
    pharmacyId: qScalar(query.pharmacyId) || undefined
  });

  const { rows: enriched } = await enrichOpenRowsWithLabels(companyId, openRows);
  const filtered = filterEnrichedRows(enriched, query);
  const totals = computeTotals(filtered);
  const aggregated = aggregateRows(filtered, groupBy);

  const { page, limit } = parsePagination(query);
  const sortBy = qScalar(query.sortBy) || 'outstanding';
  const sortOrder = qScalar(query.sortOrder) || 'desc';
  const sorted = sortAggregated(aggregated, sortBy, sortOrder);
  const total = sorted.length;
  const skip = (page - 1) * limit;
  const pageRows = sorted.slice(skip, skip + limit);

  return {
    totals,
    groupBy,
    rows: pageRows,
    pagination: {
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit) || 1)
    }
  };
};

/**
 * GET /collections/outstanding/pharmacies/:pharmacyId
 */
const pharmacyDetail = async (companyId, reqUser, pharmacyId, query = {}) => {
  if (!mongoose.Types.ObjectId.isValid(pharmacyId)) {
    throw new ApiError(404, 'Pharmacy not found');
  }

  const pharmacy = await Pharmacy.findOne({
    _id: oid(pharmacyId),
    companyId: oid(companyId),
    isDeleted: nd
  })
    .select('name city phone address isActive')
    .lean();
  if (!pharmacy) throw new ApiError(404, 'Pharmacy not found');

  const visibleRepIds = await resolveOrderVisibleMedicalRepIds(companyId, reqUser);
  const medicalRepId = qScalar(query.medicalRepId) || undefined;
  const openRows = await loadScopedOpenRows(companyId, visibleRepIds, {
    pharmacyId,
    medicalRepId
  });

  if (!openRows.length) {
    throw new ApiError(404, 'Pharmacy not found');
  }

  const { rows: enriched } = await enrichOpenRowsWithLabels(companyId, openRows);
  const totals = computeTotals(enriched);

  const invoices = enriched
    .map((r) => ({
      deliveryId: r.deliveryId,
      invoiceNumber: r.invoiceNumber,
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      medicalRepId: r.medicalRepId,
      medicalRepName: r.medicalRepName,
      deliveredAt: r.deliveredAt,
      dueDate: r.dueDate,
      invoiceAmount: r.invoiceAmount,
      outstanding: r.open,
      paymentStatus: r.paymentStatus
    }))
    .sort((a, b) => new Date(a.deliveredAt || 0) - new Date(b.deliveredAt || 0));

  const historyLimit = Math.min(50, Math.max(1, parseInt(query.historyLimit, 10) || 20));
  const collections = await Collection.find({
    companyId: oid(companyId),
    pharmacyId: oid(pharmacyId),
    isDeleted: nd
  })
    .populate('collectedBy', 'name')
    .sort({ date: -1 })
    .limit(historyLimit)
    .lean();

  const collectionHistory = collections.map((c) => ({
    _id: c._id,
    amount: roundPKR(c.amount),
    paymentMethod: c.paymentMethod,
    collectorType: c.collectorType,
    date: c.date,
    referenceNumber: c.referenceNumber || null,
    notes: c.notes || null,
    collectedBy: c.collectedBy
      ? { _id: c.collectedBy._id, name: c.collectedBy.name }
      : null,
    allocations: (c.allocations || []).map((a) => ({
      deliveryId: a.deliveryId,
      orderId: a.orderId,
      amount: roundPKR(a.amount)
    }))
  }));

  return {
    pharmacy: {
      _id: pharmacy._id,
      name: pharmacy.name,
      city: pharmacy.city,
      phone: pharmacy.phone,
      address: pharmacy.address,
      isActive: pharmacy.isActive
    },
    outstanding: totals.outstanding,
    invoiceCount: totals.invoiceCount,
    medicalRepCount: totals.medicalRepCount,
    invoices,
    collectionHistory,
    methodologyNote:
      'Outstanding is the open FIFO balance on invoices (deliveries) for orders assigned to medical reps in your scope. It may differ from the pharmacy full ledger balance when multiple reps have invoices at this pharmacy.'
  };
};

module.exports = {
  list,
  pharmacyDetail,
  resolveOutstandingRepId,
  buildOpenByDeliveryFromLedgerLines: financialService.buildOpenByDeliveryFromLedgerLines,
  deriveInvoicePaymentStatus,
  areaZoneFromTerritory,
  aggregateRows,
  GROUP_BY,
  PAYMENT_STATUS
};
