const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Order = require('../models/Order');
const Collection = require('../models/Collection');
const DeliveryRecord = require('../models/DeliveryRecord');
const { parsePagination } = require('../utils/pagination');
const { roundPKR } = require('../utils/currency');
const {
  LEDGER_ENTITY_TYPE,
  LEDGER_REFERENCE_TYPE,
  SUPPLIER_LEDGER_TYPE,
  SUPPLIER_LEDGER_ADJUSTMENT_EFFECT,
  EXPENSE_CATEGORY
} = require('../constants/enums');
const Supplier = require('../models/Supplier');
const SupplierLedger = require('../models/SupplierLedger');
const Expense = require('../models/Expense');
const User = require('../models/User');
const Account = require('../models/Account');
const financialService = require('./financial.service');
const businessTime = require('../utils/businessTime');
const {
  escapeRegex,
  qScalar,
  applyDateFieldRangeFromQuery,
  applyCreatedByFromQuery,
  queryDateBound
} = require('../utils/listQuery');

const nd = { $ne: true };

const sumNetPrior = async (baseFilter, dateVal, idVal) => {
  const priorFilter = {
    ...baseFilter,
    $or: [{ date: { $lt: dateVal } }, { $and: [{ date: dateVal }, { _id: { $lt: idVal } }] }]
  };
  const r = await Ledger.aggregate([
    { $match: priorFilter },
    {
      $group: {
        _id: null,
        d: { $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] } },
        c: { $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] } }
      }
    }
  ]);
  const row = r[0];
  return roundPKR((row?.d || 0) - (row?.c || 0));
};

/** DR−CR for all ledger rows matching filter. */
const netBalanceForFilter = async (filter) => {
  const r = await Ledger.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        d: { $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] } },
        c: { $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] } }
      }
    }
  ]);
  const row = r[0];
  return roundPKR((row?.d || 0) - (row?.c || 0));
};

const afterCursorClause = (c) => ({
  $or: [{ date: { $gt: c.date } }, { $and: [{ date: c.date }, { _id: { $gt: c._id } }] }]
});

const parseCursorParam = (raw) => {
  if (!raw) return null;
  try {
    const j = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
    if (!j.d || !j.i) return null;
    return { date: new Date(j.d), _id: new mongoose.Types.ObjectId(j.i) };
  } catch {
    return null;
  }
};

const encodeCursorFromDoc = (doc) =>
  Buffer.from(
    JSON.stringify({ d: doc.date instanceof Date ? doc.date.toISOString() : doc.date, i: String(doc._id) }),
    'utf8'
  ).toString('base64');

/**
 * Optional: narrow ledger lines to order/invoice/collection document references matching free text.
 */
const mergeDocSearchIntoFilter = async (filter, companyId, pharmacyId, term) => {
  const t = qScalar(term);
  if (!t || t.length < 2) return false;
  const cid = new mongoose.Types.ObjectId(companyId);
  const pid = new mongoose.Types.ObjectId(pharmacyId);
  const rx = new RegExp(escapeRegex(t), 'i');
  const [orders, delivs, colls] = await Promise.all([
    Order.find({ companyId: cid, pharmacyId: pid, orderNumber: rx, isDeleted: nd }).select('_id').lean().limit(50),
    DeliveryRecord.find({ companyId: cid, invoiceNumber: rx, isDeleted: nd }).select('_id').lean().limit(50),
    Collection.find({ companyId: cid, pharmacyId: pid, referenceNumber: rx, isDeleted: nd }).select('_id').lean().limit(50)
  ]);
  const or = [];
  const oids = orders.map((o) => o._id);
  const dids = delivs.map((d) => d._id);
  const cids = colls.map((c) => c._id);
  if (oids.length) {
    or.push({ 'meta.orderId': { $in: oids } });
    or.push({ referenceType: LEDGER_REFERENCE_TYPE.ORDER, referenceId: { $in: oids } });
  }
  if (dids.length) {
    or.push({ referenceType: LEDGER_REFERENCE_TYPE.DELIVERY, referenceId: { $in: dids } });
    or.push({ 'meta.deliveryId': { $in: dids } });
  }
  if (cids.length) or.push({ referenceType: LEDGER_REFERENCE_TYPE.COLLECTION, referenceId: { $in: cids } });
  if (!or.length) return true;
  if (!filter.$and) filter.$and = [];
  filter.$and.push({ $or: or });
  return false;
};

/**
 * Best-effort labels for UI (order number, invoice, collection reference) — does not alter amounts or ledger rows.
 */
const enrichPharmacyLedgerLines = async (companyId, docs) => {
  const cid = new mongoose.Types.ObjectId(companyId);
  const orderIds = new Set();
  const deliveryIds = new Set();
  const collectionIds = new Set();

  for (const d of docs) {
    const oid = d.meta?.orderId;
    if (oid) orderIds.add(String(oid));
    let did = null;
    if (d.meta?.deliveryId) did = String(d.meta.deliveryId);
    else if (d.referenceType === LEDGER_REFERENCE_TYPE.DELIVERY && d.referenceId) {
      did = String(d.referenceId);
    }
    if (did) deliveryIds.add(did);
    if (d.referenceType === LEDGER_REFERENCE_TYPE.COLLECTION && d.referenceId) {
      collectionIds.add(String(d.referenceId));
    }
  }

  const toOid = (s) => new mongoose.Types.ObjectId(s);

  const [orders, deliveries, collections] = await Promise.all([
    orderIds.size
      ? Order.find({ companyId: cid, _id: { $in: [...orderIds].map(toOid) } }).select('orderNumber').lean()
      : [],
    deliveryIds.size
      ? DeliveryRecord.find({ companyId: cid, _id: { $in: [...deliveryIds].map(toOid) } })
          .select('invoiceNumber orderId')
          .lean()
      : [],
    collectionIds.size
      ? Collection.find({ companyId: cid, _id: { $in: [...collectionIds].map(toOid) } })
          .select('referenceNumber')
          .lean()
      : []
  ]);

  const orderMap = new Map(orders.map((o) => [o._id.toString(), o]));
  const deliveryMap = new Map(deliveries.map((x) => [x._id.toString(), x]));
  const collectionMap = new Map(collections.map((x) => [x._id.toString(), x]));

  return docs.map((d) => {
    const meta = d.meta || {};
    const orderIdStr = meta.orderId ? String(meta.orderId) : null;
    const delIdStr = meta.deliveryId
      ? String(meta.deliveryId)
      : d.referenceType === LEDGER_REFERENCE_TYPE.DELIVERY && d.referenceId
        ? String(d.referenceId)
        : null;
    const colIdStr =
      d.referenceType === LEDGER_REFERENCE_TYPE.COLLECTION && d.referenceId ? String(d.referenceId) : null;
    const order = orderIdStr ? orderMap.get(orderIdStr) : null;
    const delivery = delIdStr ? deliveryMap.get(delIdStr) : null;
    const collection = colIdStr ? collectionMap.get(colIdStr) : null;
    const pieces = [];
    if (order?.orderNumber) pieces.push(`Order ${order.orderNumber}`);
    if (delivery?.invoiceNumber) pieces.push(`Inv ${delivery.invoiceNumber}`);
    if (collection?.referenceNumber) pieces.push(`Ref ${collection.referenceNumber}`);
    const primaryLabel = pieces.length ? pieces.join(' · ') : null;
    const derivedOrderId =
      orderIdStr || (delivery?.orderId ? String(delivery.orderId) : null);
    return {
      ...d,
      enrich: {
        primaryLabel,
        orderNumber: order?.orderNumber || null,
        orderId: derivedOrderId,
        invoiceNumber: delivery?.invoiceNumber || null,
        collectionRef: collection?.referenceNumber || null
      }
    };
  });
};

const buildPharmacyBase = (companyId, pharmacyId) => ({
  companyId: new mongoose.Types.ObjectId(companyId),
  entityId: new mongoose.Types.ObjectId(pharmacyId),
  entityType: LEDGER_ENTITY_TYPE.PHARMACY,
  isDeleted: nd
});

const applyPharmacyLedgerQuery = (filter, query, timeZone) => {
  const rt = qScalar(query.referenceType);
  if (rt && Object.values(LEDGER_REFERENCE_TYPE).includes(rt)) {
    filter.referenceType = rt;
  }

  applyDateFieldRangeFromQuery(filter, query, 'date', timeZone);

  const searchTerm = qScalar(query.search);
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.description = { $regex: rx, $options: 'i' };
  }

  const minA = parseFloat(qScalar(query.minAmount));
  const maxA = parseFloat(qScalar(query.maxAmount));
  if (!Number.isNaN(minA) && minA > 0) {
    filter.amount = { ...(filter.amount || {}), $gte: minA };
  }
  if (!Number.isNaN(maxA) && maxA > 0) {
    filter.amount = { ...(filter.amount || {}), $lte: maxA };
  }
};

const attachRunningAscending = async (companyId, filter, linesAsc, openingBalance) => {
  let running = openingBalance;
  const withRun = linesAsc.map((line) => {
    const debit = line.type === 'DEBIT' ? line.amount : 0;
    const credit = line.type === 'CREDIT' ? line.amount : 0;
    running = roundPKR(running + debit - credit);
    return { ...line, runningBalance: running };
  });
  return enrichPharmacyLedgerLines(companyId, withRun);
};

const list = async (companyId, query, timeZone = 'UTC') => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.entityId) filter.entityId = query.entityId;
  if (query.type) filter.type = query.type;
  applyDateFieldRangeFromQuery(filter, query, 'date', timeZone);
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.description = { $regex: rx, $options: 'i' };
  }
  applyCreatedByFromQuery(filter, query);

  const [docs, total] = await Promise.all([
    Ledger.find(filter).sort(sort).skip(skip).limit(limit),
    Ledger.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

/**
 * Pharmacy ledger lines. Backward-compatible: supports `page` + `limit`, or `cursor` (base64 JSON {d,i}) for chronological load-more.
 * Running balance: server-computed when `includeRunning` is not `0` and sort is by date (asc or desc-reordered).
 */
const getByPharmacy = async (companyId, pharmacyId, query, timeZone = 'UTC') => {
  const limit = Math.min(100, Math.max(1, parseInt(qScalar(query.limit) || '25', 10) || 25));
  const page = Math.max(1, parseInt(qScalar(query.page) || '1', 10) || 1);
  const skip = (page - 1) * limit;

  const filter = buildPharmacyBase(companyId, pharmacyId);
  applyPharmacyLedgerQuery(filter, query, timeZone);

  const impossibleDoc = await mergeDocSearchIntoFilter(filter, companyId, pharmacyId, query.docSearch);
  if (impossibleDoc) {
    return {
      docs: [],
      total: 0,
      page,
      limit,
      openingBalance: 0,
      nextCursor: null,
      hasMore: false,
      cursorMode: false
    };
  }

  const sortBy = qScalar(query.sortBy) || 'date';
  const asc = qScalar(query.sortOrder) !== 'desc';
  const dir = asc ? 1 : -1;
  const sort = {};
  if (sortBy === 'date') {
    sort.date = dir;
    sort._id = dir;
  } else if (sortBy === 'amount') {
    sort.amount = dir;
    sort._id = dir;
  } else {
    sort.createdAt = -1;
  }

  const cursor = parseCursorParam(qScalar(query.cursor));
  const useCursor = Boolean(cursor && sortBy === 'date' && asc);
  if (useCursor) {
    if (!filter.$and) filter.$and = [];
    filter.$and.push(afterCursorClause(cursor));
  }

  const total = await Ledger.countDocuments(filter);

  let docs;
  if (useCursor) {
    docs = await Ledger.find(filter).sort({ date: 1, _id: 1 }).limit(limit).lean();
  } else {
    docs = await Ledger.find(filter).sort(sort).skip(useCursor ? 0 : skip).limit(limit).lean();
  }

  const rb = qScalar(query.runningBalance).toLowerCase();
  const wantRunning = sortBy === 'date' && qScalar(query.includeRunning) !== '0' && rb !== 'false';

  let openingBalance = null;
  let enriched;

  if (!wantRunning || sortBy !== 'date') {
    openingBalance = null;
    enriched = await enrichPharmacyLedgerLines(companyId, docs);
  } else if (asc && !useCursor) {
    if (skip === 0) openingBalance = 0;
    else {
      const first = await Ledger.findOne(filter).sort(sort).skip(skip).limit(1).select('date _id').lean();
      openingBalance = first ? await sumNetPrior(filter, first.date, first._id) : 0;
    }
    enriched = await attachRunningAscending(companyId, filter, docs, openingBalance);
  } else if (asc && useCursor) {
    if (!docs.length) {
      openingBalance = 0;
      enriched = [];
    } else {
      openingBalance = await sumNetPrior(filter, docs[0].date, docs[0]._id);
      enriched = await attachRunningAscending(companyId, filter, docs, openingBalance);
    }
  } else {
    const docsDesc = docs;
    const docsAsc = [...docsDesc].sort((a, b) => {
      const td = new Date(a.date) - new Date(b.date);
      if (td !== 0) return td;
      return String(a._id).localeCompare(String(b._id));
    });
    openingBalance =
      docsAsc.length > 0 ? await sumNetPrior(filter, docsAsc[0].date, docsAsc[0]._id) : 0;
    const ascEnriched = await attachRunningAscending(companyId, filter, docsAsc, openingBalance);
    const byId = new Map(ascEnriched.map((e) => [String(e._id), e]));
    enriched = docsDesc.map((d) => byId.get(String(d._id)));
  }

  let nextCursor = null;
  let hasMore = false;
  if (useCursor && docs.length) {
    const last = docs[docs.length - 1];
    const tail = { ...filter };
    if (!tail.$and) tail.$and = [];
    tail.$and.push(afterCursorClause({ date: last.date, _id: last._id }));
    const remain = await Ledger.countDocuments(tail);
    hasMore = remain > 0;
    if (hasMore) nextCursor = encodeCursorFromDoc(last);
  }

  return {
    docs: enriched,
    total,
    page: useCursor ? 1 : page,
    limit,
    openingBalance: wantRunning && sortBy === 'date' ? openingBalance : null,
    nextCursor,
    hasMore,
    cursorMode: useCursor
  };
};

/**
 * Chronological export for PDF (cap rows for safety).
 */
const fetchPharmacyLedgerChronological = async (companyId, pharmacyId, query, timeZone, cap = 5000) => {
  const filter = buildPharmacyBase(companyId, pharmacyId);
  applyPharmacyLedgerQuery(filter, query, timeZone);
  const impossibleDoc = await mergeDocSearchIntoFilter(filter, companyId, pharmacyId, query.docSearch);
  if (impossibleDoc)
    return { lines: [], openingBalance: 0, closingBalance: 0, totals: { debit: 0, credit: 0 } };

  let openingBalance = 0;
  const fromRaw = qScalar(query.from);
  if (fromRaw) {
    try {
      const zone = businessTime.requireCompanyIanaZone(timeZone);
      const t0 = queryDateBound(fromRaw, 'start', zone);
      if (t0) {
        const preF = { ...filter };
        delete preF.date;
        preF.date = { $lt: t0 };
        openingBalance = await netBalanceForFilter(preF);
      }
    } catch {
      /* invalid from */
    }
  }

  const docs = await Ledger.find(filter).sort({ date: 1, _id: 1 }).limit(cap).lean();
  const enriched = await attachRunningAscending(companyId, filter, docs, openingBalance);
  let debit = 0;
  let credit = 0;
  for (const L of docs) {
    if (L.type === 'DEBIT') debit = roundPKR(debit + L.amount);
    else credit = roundPKR(credit + L.amount);
  }
  const closingBalance = enriched.length ? enriched[enriched.length - 1].runningBalance : openingBalance;
  return {
    lines: enriched,
    openingBalance,
    closingBalance,
    totals: { debit, credit }
  };
};

const getBalance = async (companyId, pharmacyId) => {
  const result = await Ledger.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        entityId: new mongoose.Types.ObjectId(pharmacyId),
        entityType: LEDGER_ENTITY_TYPE.PHARMACY,
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

  const bal = result[0] || { totalDebit: 0, totalCredit: 0 };
  return {
    totalDebit: roundPKR(bal.totalDebit),
    totalCredit: roundPKR(bal.totalCredit),
    outstanding: roundPKR(bal.totalDebit - bal.totalCredit)
  };
};

const getDistributorClearingBalance = (companyId, distributorId) =>
  financialService.getDistributorClearingBalance(companyId, distributorId);

const attachRunningWithDebitCredit = (linesAsc, openingBalance) => {
  let running = openingBalance;
  return linesAsc.map((line) => {
    const debit = line.type === 'DEBIT' ? roundPKR(line.amount) : 0;
    const credit = line.type === 'CREDIT' ? roundPKR(line.amount) : 0;
    running = roundPKR(running + debit - credit);
    return { ...line, debit, credit, runningBalance: running };
  });
};

/**
 * Chronological client ledger (pharmacy receivable or distributor clearing) for statement UI.
 */
const fetchClientLedgerChronological = async (companyId, clientId, entityType, query, timeZone, cap = 5000) => {
  const filter = {
    companyId: new mongoose.Types.ObjectId(companyId),
    entityId: new mongoose.Types.ObjectId(clientId),
    entityType,
    isDeleted: nd
  };
  applyDateFieldRangeFromQuery(filter, query, 'date', timeZone);

  let openingBalance = 0;
  const fromRaw = qScalar(query.from);
  if (fromRaw) {
    try {
      const zone = businessTime.requireCompanyIanaZone(timeZone);
      const t0 = queryDateBound(fromRaw, 'start', zone);
      if (t0) {
        const preF = { ...filter };
        delete preF.date;
        preF.date = { $lt: t0 };
        openingBalance = await netBalanceForFilter(preF);
      }
    } catch {
      /* invalid from */
    }
  }

  const docs = await Ledger.find(filter).sort({ date: 1, _id: 1 }).limit(cap).lean();
  let lines = attachRunningWithDebitCredit(docs, openingBalance);
  if (entityType === LEDGER_ENTITY_TYPE.PHARMACY) {
    lines = await enrichPharmacyLedgerLines(companyId, lines);
  }

  let debit = 0;
  let credit = 0;
  for (const L of docs) {
    if (L.type === 'DEBIT') debit = roundPKR(debit + L.amount);
    else credit = roundPKR(credit + L.amount);
  }
  const closingBalance = lines.length ? lines[lines.length - 1].runningBalance : openingBalance;

  return {
    entries: lines,
    openingBalance,
    closingBalance,
    totals: { debit, credit }
  };
};

const getClientStatement = async (companyId, query, timeZone = 'UTC') => {
  const ApiError = require('../utils/ApiError');
  const clientType = (qScalar(query.clientType) || '').toUpperCase();
  const clientId = qScalar(query.clientId);
  if (!clientId) throw new ApiError(400, 'clientId is required');

  let entityType;
  if (clientType === 'PHARMACY') entityType = LEDGER_ENTITY_TYPE.PHARMACY;
  else if (clientType === 'DISTRIBUTOR') entityType = LEDGER_ENTITY_TYPE.DISTRIBUTOR_CLEARING;
  else throw new ApiError(400, 'clientType must be PHARMACY or DISTRIBUTOR');

  const Pharmacy = require('../models/Pharmacy');
  const Distributor = require('../models/Distributor');
  const cid = new mongoose.Types.ObjectId(companyId);

  let clientName = '';
  if (entityType === LEDGER_ENTITY_TYPE.PHARMACY) {
    const p = await Pharmacy.findOne({ _id: new mongoose.Types.ObjectId(clientId), companyId: cid, isDeleted: nd }).lean();
    if (!p) throw new ApiError(404, 'Pharmacy not found');
    clientName = p.name;
  } else {
    const d = await Distributor.findOne({ _id: new mongoose.Types.ObjectId(clientId), companyId: cid, isDeleted: nd }).lean();
    if (!d) throw new ApiError(404, 'Distributor not found');
    clientName = d.name;
  }

  const stmt = await fetchClientLedgerChronological(companyId, clientId, entityType, query, timeZone);
  return {
    clientType,
    clientId,
    clientName,
    entityType,
    ...stmt
  };
};

const applySupplierRowToBalance = (balance, row) => {
  const amt = roundPKR(row.amount || 0);
  if (row.type === SUPPLIER_LEDGER_TYPE.PURCHASE) return roundPKR(balance + amt);
  if (row.type === SUPPLIER_LEDGER_TYPE.PAYMENT || row.type === SUPPLIER_LEDGER_TYPE.PURCHASE_RETURN) {
    return roundPKR(balance - amt);
  }
  if (row.type === SUPPLIER_LEDGER_TYPE.ADJUSTMENT && row.adjustmentEffect) {
    if (row.adjustmentEffect === SUPPLIER_LEDGER_ADJUSTMENT_EFFECT.INCREASE_PAYABLE) return roundPKR(balance + amt);
    if (row.adjustmentEffect === SUPPLIER_LEDGER_ADJUSTMENT_EFFECT.DECREASE_PAYABLE) return roundPKR(balance - amt);
  }
  return balance;
};

const supplierRowToDebitCredit = (row) => {
  const amt = roundPKR(row.amount || 0);
  if (row.type === SUPPLIER_LEDGER_TYPE.PURCHASE) return { debit: amt, credit: 0 };
  if (row.type === SUPPLIER_LEDGER_TYPE.PAYMENT || row.type === SUPPLIER_LEDGER_TYPE.PURCHASE_RETURN) {
    return { debit: 0, credit: amt };
  }
  if (row.type === SUPPLIER_LEDGER_TYPE.ADJUSTMENT && row.adjustmentEffect) {
    if (row.adjustmentEffect === SUPPLIER_LEDGER_ADJUSTMENT_EFFECT.INCREASE_PAYABLE) return { debit: amt, credit: 0 };
    if (row.adjustmentEffect === SUPPLIER_LEDGER_ADJUSTMENT_EFFECT.DECREASE_PAYABLE) return { debit: 0, credit: amt };
  }
  return { debit: 0, credit: 0 };
};

const supplierRowDescription = (row) => {
  if (row.notes) return row.notes;
  if (row.type === SUPPLIER_LEDGER_TYPE.PURCHASE) return 'Purchase / goods received';
  if (row.type === SUPPLIER_LEDGER_TYPE.PAYMENT) return 'Payment to supplier';
  if (row.type === SUPPLIER_LEDGER_TYPE.PURCHASE_RETURN) return 'Purchase return';
  if (row.type === SUPPLIER_LEDGER_TYPE.ADJUSTMENT) return 'Payable adjustment';
  return row.referenceType || row.type;
};

const sumExpenseAmounts = (rows) => roundPKR(rows.reduce((s, r) => roundPKR(s + (r.amount || 0)), 0));

/**
 * Supplier payable ledger (PURCHASE/adjustments increase debit side; PAYMENT/returns increase credit side).
 */
const fetchSupplierLedgerChronological = async (companyId, supplierId, query, timeZone, cap = 5000) => {
  const cid = new mongoose.Types.ObjectId(companyId);
  const sid = new mongoose.Types.ObjectId(supplierId);
  const baseFilter = { companyId: cid, supplierId: sid, isDeleted: nd };

  let openingBalance = 0;
  const fromRaw = qScalar(query.from);
  if (fromRaw) {
    try {
      const zone = businessTime.requireCompanyIanaZone(timeZone);
      const t0 = queryDateBound(fromRaw, 'start', zone);
      if (t0) {
        const preRows = await SupplierLedger.find({ ...baseFilter, date: { $lt: t0 } })
          .sort({ date: 1, _id: 1 })
          .lean();
        for (const row of preRows) openingBalance = applySupplierRowToBalance(openingBalance, row);
      }
    } catch {
      /* invalid from */
    }
  }

  const s = await Supplier.findOne({ _id: sid, companyId: cid, isDeleted: nd }).lean();
  if (!s) {
    const ApiError = require('../utils/ApiError');
    throw new ApiError(404, 'Supplier not found');
  }
  openingBalance = roundPKR(openingBalance + roundPKR(s.openingBalance || 0));

  const filter = { ...baseFilter };
  applyDateFieldRangeFromQuery(filter, query, 'date', timeZone);
  const docs = await SupplierLedger.find(filter).sort({ date: 1, _id: 1 }).limit(cap).lean();

  let running = openingBalance;
  let debit = 0;
  let credit = 0;
  const entries = docs.map((row) => {
    const { debit: d, credit: c } = supplierRowToDebitCredit(row);
    debit = roundPKR(debit + d);
    credit = roundPKR(credit + c);
    running = roundPKR(running + d - c);
    return {
      _id: row._id,
      date: row.date,
      referenceType: row.referenceType || row.type,
      type: row.type,
      description: supplierRowDescription(row),
      debit: d,
      credit: c,
      runningBalance: running,
      voucherNumber: row.voucherNumber || null
    };
  });

  const closingBalance = entries.length ? entries[entries.length - 1].runningBalance : openingBalance;
  return {
    entries,
    openingBalance,
    closingBalance,
    totals: { debit, credit }
  };
};

const getSupplierStatement = async (companyId, query, timeZone = 'UTC') => {
  const ApiError = require('../utils/ApiError');
  const supplierId = qScalar(query.supplierId);
  if (!supplierId) throw new ApiError(400, 'supplierId is required');

  const cid = new mongoose.Types.ObjectId(companyId);
  const s = await Supplier.findOne({ _id: new mongoose.Types.ObjectId(supplierId), companyId: cid, isDeleted: nd })
    .select('name city phone')
    .lean();
  if (!s) throw new ApiError(404, 'Supplier not found');

  const stmt = await fetchSupplierLedgerChronological(companyId, supplierId, query, timeZone);
  return {
    supplierId,
    supplierName: s.name,
    supplierCity: s.city,
    ...stmt
  };
};

/**
 * Company expense activity — each expense is a debit; running total is cumulative spend in period.
 */
const fetchExpenseLedgerChronological = async (companyId, query, timeZone, cap = 5000) => {
  const cid = new mongoose.Types.ObjectId(companyId);
  const baseFilter = { companyId: cid, isDeleted: nd };
  const category = qScalar(query.category);
  const expenseAccountId = qScalar(query.expenseAccountId);
  if (category) baseFilter.category = category;
  if (expenseAccountId) baseFilter.expenseAccountId = new mongoose.Types.ObjectId(expenseAccountId);

  let openingBalance = 0;
  const fromRaw = qScalar(query.from);
  if (fromRaw) {
    try {
      const zone = businessTime.requireCompanyIanaZone(timeZone);
      const t0 = queryDateBound(fromRaw, 'start', zone);
      if (t0) {
        const preFilter = { ...baseFilter, date: { $lt: t0 } };
        const preRows = await Expense.find(preFilter).select('amount').lean();
        openingBalance = sumExpenseAmounts(preRows);
      }
    } catch {
      /* invalid from */
    }
  }

  const filter = { ...baseFilter };
  applyDateFieldRangeFromQuery(filter, query, 'date', timeZone);
  const docs = await Expense.find(filter)
    .sort({ date: 1, _id: 1 })
    .limit(cap)
    .populate('employeeId', 'name')
    .populate('expenseAccountId', 'name code')
    .lean();

  let running = openingBalance;
  let debit = 0;
  const entries = docs.map((row) => {
    const d = roundPKR(row.amount || 0);
    debit = roundPKR(debit + d);
    running = roundPKR(running + d);
    const employeeName = row.employeeId?.name;
    const accountName = row.expenseAccountId?.name;
    const baseDesc = row.description || accountName || row.category?.replace(/_/g, ' ') || 'Expense';
    const desc = employeeName ? `${baseDesc} (${employeeName})` : baseDesc;
    return {
      _id: row._id,
      date: row.date,
      referenceType: 'EXPENSE',
      category: accountName || row.category,
      description: desc,
      debit: d,
      credit: 0,
      runningBalance: running
    };
  });

  const closingBalance = entries.length ? entries[entries.length - 1].runningBalance : openingBalance;
  return {
    entries,
    openingBalance,
    closingBalance,
    totals: { debit, credit: 0 },
    category: category || null
  };
};

const getExpenseLedger = async (companyId, query, timeZone = 'UTC') => {
  const expenseAccountId = qScalar(query.expenseAccountId);
  const stmt = await fetchExpenseLedgerChronological(companyId, query, timeZone);
  let categoryLabel = 'All expense accounts';
  if (expenseAccountId) {
    const acc = await Account.findOne({
      companyId: new mongoose.Types.ObjectId(companyId),
      _id: new mongoose.Types.ObjectId(expenseAccountId),
      isDeleted: nd
    })
      .select('name')
      .lean();
    categoryLabel = acc?.name || 'Selected account';
  }
  return {
    expenseAccountId: expenseAccountId || null,
    categoryLabel,
    ...stmt
  };
};

/**
 * Expenses attributed to an employee (includes salary from paid payroll).
 */
const fetchEmployeeLedgerChronological = async (companyId, employeeId, query, timeZone, cap = 5000) => {
  const cid = new mongoose.Types.ObjectId(companyId);
  const eid = new mongoose.Types.ObjectId(employeeId);
  const baseFilter = { companyId: cid, employeeId: eid, isDeleted: nd };

  let openingBalance = 0;
  const fromRaw = qScalar(query.from);
  if (fromRaw) {
    try {
      const zone = businessTime.requireCompanyIanaZone(timeZone);
      const t0 = queryDateBound(fromRaw, 'start', zone);
      if (t0) {
        const preRows = await Expense.find({ ...baseFilter, date: { $lt: t0 } }).select('amount').lean();
        openingBalance = sumExpenseAmounts(preRows);
      }
    } catch {
      /* invalid from */
    }
  }

  const filter = { ...baseFilter };
  applyDateFieldRangeFromQuery(filter, query, 'date', timeZone);
  const docs = await Expense.find(filter).sort({ date: 1, _id: 1 }).limit(cap).lean();

  let running = openingBalance;
  let debit = 0;
  const entries = docs.map((row) => {
    const d = roundPKR(row.amount || 0);
    debit = roundPKR(debit + d);
    running = roundPKR(running + d);
    return {
      _id: row._id,
      date: row.date,
      referenceType: row.category === EXPENSE_CATEGORY.SALARY ? 'SALARY' : 'EXPENSE',
      category: row.category,
      description: row.description || row.category.replace(/_/g, ' '),
      debit: d,
      credit: 0,
      runningBalance: running
    };
  });

  const closingBalance = entries.length ? entries[entries.length - 1].runningBalance : openingBalance;
  return {
    entries,
    openingBalance,
    closingBalance,
    totals: { debit, credit: 0 }
  };
};

const getEmployeeStatement = async (companyId, query, timeZone = 'UTC') => {
  const ApiError = require('../utils/ApiError');
  const employeeId = qScalar(query.employeeId);
  if (!employeeId) throw new ApiError(400, 'employeeId is required');

  const cid = new mongoose.Types.ObjectId(companyId);
  const user = await User.findOne({
    _id: new mongoose.Types.ObjectId(employeeId),
    companyId: cid,
    isDeleted: nd
  })
    .select('name email employeeCode role')
    .lean();
  if (!user) throw new ApiError(404, 'Employee not found');

  const stmt = await fetchEmployeeLedgerChronological(companyId, employeeId, query, timeZone);
  return {
    employeeId,
    employeeName: user.name,
    employeeCode: user.employeeCode || null,
    ...stmt
  };
};

module.exports = {
  list,
  getByPharmacy,
  getBalance,
  getDistributorClearingBalance,
  fetchPharmacyLedgerChronological,
  getClientStatement,
  getSupplierStatement,
  getExpenseLedger,
  getEmployeeStatement
};
