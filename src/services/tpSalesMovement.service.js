/**
 * Sales Movement (TP) — explains Company Dashboard Gross TP Sales (totalGrossSalesTp).
 * Same engine as tpSalesRollup.computeDashboardNetGrossSalesTp:
 * event-date D − R − A, excluding currently fully qty-credited orders.
 * Net TP Sales = Gross Deliveries − Returns − Amendments (current/prior/unclassified).
 */
const mongoose = require('mongoose');
const DeliveryRecord = require('../models/DeliveryRecord');
const ReturnRecord = require('../models/ReturnRecord');
const OrderAmendment = require('../models/OrderAmendment');
const Pharmacy = require('../models/Pharmacy');
const User = require('../models/User');
const Product = require('../models/Product');
const ApiError = require('../utils/ApiError');
const { roundPKR } = require('../utils/currency');
const { escapeRegex, qScalar } = require('../utils/listQuery');
const businessTime = require('../utils/businessTime');
const { classifySourceDeliveryPeriod } = require('../utils/sourceDeliverySnapshot.util');
const {
  grossTpForDelivery,
  sumReturnTp,
  sumAmendmentTp,
  isOrderFullyCredited,
} = require('./tpSalesRollup.service');

const nd = { $ne: true };
const objectId = (id) => new mongoose.Types.ObjectId(id);

const emptyMovement = () => ({
  grossDeliveriesTp: 0,
  returnsCurrentPeriodTp: 0,
  returnsPriorPeriodTp: 0,
  amendmentsCurrentPeriodTp: 0,
  amendmentsPriorPeriodTp: 0,
  returnsUnclassifiedTp: 0,
  amendmentsUnclassifiedTp: 0,
  netTpSales: 0
});

const finalizeMovement = (m) => {
  const out = {
    grossDeliveriesTp: roundPKR(m.grossDeliveriesTp || 0),
    returnsCurrentPeriodTp: roundPKR(m.returnsCurrentPeriodTp || 0),
    returnsPriorPeriodTp: roundPKR(m.returnsPriorPeriodTp || 0),
    amendmentsCurrentPeriodTp: roundPKR(m.amendmentsCurrentPeriodTp || 0),
    amendmentsPriorPeriodTp: roundPKR(m.amendmentsPriorPeriodTp || 0),
    returnsUnclassifiedTp: roundPKR(m.returnsUnclassifiedTp || 0),
    amendmentsUnclassifiedTp: roundPKR(m.amendmentsUnclassifiedTp || 0),
    netTpSales: 0
  };
  out.netTpSales = roundPKR(
    out.grossDeliveriesTp -
      out.returnsCurrentPeriodTp -
      out.returnsPriorPeriodTp -
      out.amendmentsCurrentPeriodTp -
      out.amendmentsPriorPeriodTp -
      out.returnsUnclassifiedTp -
      out.amendmentsUnclassifiedTp
  );
  return out;
};

/** Line TP matching tpSalesRollup.sumReturnTp (order tpAtTime × physical qty). */
const returnLineTp = (item, order) => {
  const oi = order?.items?.find((i) => String(i.productId) === String(item.productId));
  if (oi) return roundPKR(Number(oi.tpAtTime) * Number(item.quantity));
  if (item.tpAmount != null && Number.isFinite(Number(item.tpAmount))) {
    return roundPKR(Number(item.tpAmount));
  }
  return 0;
};

/** Line TP matching tpSalesRollup.sumAmendmentTp line fallback. */
const amendmentLineTp = (item, order) => {
  if (item.tpDelta != null && Number.isFinite(Number(item.tpDelta))) {
    return roundPKR(Number(item.tpDelta));
  }
  const oi = order?.items?.find((i) => String(i.productId) === String(item.productId));
  return roundPKR((Number(oi?.tpAtTime) || 0) * (Number(item.deltaQty) || 0));
};

const resolveSourceYmForLine = (item, doc, deliveryById, deliveriesByOrder, eventYm, tz) => {
  if (item.sourceDeliveryYm) return String(item.sourceDeliveryYm);

  const candId =
    item.sourceDeliveryId ||
    item.deliveryId ||
    (doc.allocations || []).find((a) => a.deliveryId)?.deliveryId ||
    null;

  let delivery = candId ? deliveryById.get(String(candId)) : null;
  if (!delivery) {
    const orderId = String(doc.orderId?._id || doc.orderId);
    const list = deliveriesByOrder.get(orderId) || [];
    const pid = String(item.productId);
    for (const d of list) {
      if ((d.items || []).some((i) => String(i.productId) === pid)) {
        delivery = d;
        break;
      }
    }
  }
  if (!delivery?.deliveredAt) return null;
  return businessTime.getBusinessMonthKey(delivery.deliveredAt, tz);
};

/**
 * Allocate a document-level TP debit (exact rollup amount) across current/prior/unclassified
 * using line-level source-delivery classification shares.
 */
const allocateDebitBySourcePeriod = (
  movement,
  kind, // 'returns' | 'amendments'
  docTp,
  items,
  doc,
  eventYm,
  deliveryById,
  deliveriesByOrder,
  tz,
  lineTpFn,
  order
) => {
  const total = roundPKR(docTp);
  if (total === 0) return;

  const buckets = { currentPeriod: 0, priorPeriod: 0, unclassified: 0 };
  let weightSum = 0;
  for (const item of items || []) {
    const w = Math.abs(lineTpFn(item, order));
    if (w <= 0) continue;
    const sourceYm = resolveSourceYmForLine(item, doc, deliveryById, deliveriesByOrder, eventYm, tz);
    const cls = classifySourceDeliveryPeriod(eventYm, sourceYm);
    buckets[cls] += w;
    weightSum += w;
  }

  if (weightSum <= 0) {
    if (kind === 'returns') movement.returnsUnclassifiedTp += total;
    else movement.amendmentsUnclassifiedTp += total;
    return;
  }

  const current = roundPKR(total * (buckets.currentPeriod / weightSum));
  const prior = roundPKR(total * (buckets.priorPeriod / weightSum));
  let unclassified = roundPKR(total - current - prior);
  // Absorb rounding into the largest weight bucket
  if (kind === 'returns') {
    movement.returnsCurrentPeriodTp += current;
    movement.returnsPriorPeriodTp += prior;
    movement.returnsUnclassifiedTp += unclassified;
  } else {
    movement.amendmentsCurrentPeriodTp += current;
    movement.amendmentsPriorPeriodTp += prior;
    movement.amendmentsUnclassifiedTp += unclassified;
  }
};

const loadDeliveryLookups = async (cid, orderIds) => {
  if (!orderIds.length) {
    return { deliveryById: new Map(), deliveriesByOrder: new Map() };
  }
  const deliveries = await DeliveryRecord.find({
    companyId: cid,
    orderId: { $in: orderIds },
    isDeleted: nd
  })
    .sort({ deliveredAt: -1 })
    .lean();
  const deliveryById = new Map(deliveries.map((d) => [String(d._id), d]));
  const deliveriesByOrder = new Map();
  for (const d of deliveries) {
    const oid = String(d.orderId);
    if (!deliveriesByOrder.has(oid)) deliveriesByOrder.set(oid, []);
    deliveriesByOrder.get(oid).push(d);
  }
  return { deliveryById, deliveriesByOrder };
};

/**
 * Aggregate Sales Movement for each YYYY-MM — same inclusion rules as Dashboard Gross TP.
 */
const aggregateSalesMovementByMonth = async (companyId, dateRange, timeZone, monthKeys) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const cid = objectId(companyId);
  const byMonth = new Map(monthKeys.map((m) => [m, emptyMovement()]));

  const orderSelect = 'items status medicalRepId pharmacyId orderNumber';
  const [deliveries, returns, amendments] = await Promise.all([
    DeliveryRecord.find({ companyId: cid, isDeleted: nd, deliveredAt: dateRange })
      .populate({ path: 'orderId', select: orderSelect })
      .lean(),
    ReturnRecord.find({ companyId: cid, isDeleted: nd, returnedAt: dateRange })
      .populate({ path: 'orderId', select: orderSelect })
      .lean(),
    OrderAmendment.find({ companyId: cid, isDeleted: nd, amendedAt: dateRange })
      .populate({ path: 'orderId', select: orderSelect })
      .lean()
  ]);

  const orderIds = [
    ...new Set([
      ...returns.map((r) => String(r.orderId?._id || r.orderId)).filter(Boolean),
      ...amendments.map((a) => String(a.orderId?._id || a.orderId)).filter(Boolean)
    ])
  ].map(objectId);

  const { deliveryById, deliveriesByOrder } = await loadDeliveryLookups(cid, orderIds);

  for (const d of deliveries) {
    const order = d.orderId;
    if (!order || isOrderFullyCredited(order)) continue;
    const ym = businessTime.getBusinessMonthKey(d.deliveredAt, tz);
    if (!byMonth.has(ym)) continue;
    byMonth.get(ym).grossDeliveriesTp += grossTpForDelivery(d, order);
  }

  for (const ret of returns) {
    const order = ret.orderId;
    if (!order || isOrderFullyCredited(order)) continue;
    const ym = businessTime.getBusinessMonthKey(ret.returnedAt, tz);
    if (!byMonth.has(ym)) continue;
    allocateDebitBySourcePeriod(
      byMonth.get(ym),
      'returns',
      sumReturnTp(ret, order),
      ret.items,
      ret,
      ym,
      deliveryById,
      deliveriesByOrder,
      tz,
      returnLineTp,
      order
    );
  }

  for (const amd of amendments) {
    const order = amd.orderId;
    if (!order || isOrderFullyCredited(order)) continue;
    const ym = businessTime.getBusinessMonthKey(amd.amendedAt, tz);
    if (!byMonth.has(ym)) continue;
    allocateDebitBySourcePeriod(
      byMonth.get(ym),
      'amendments',
      sumAmendmentTp(amd, order),
      amd.items,
      amd,
      ym,
      deliveryById,
      deliveriesByOrder,
      tz,
      amendmentLineTp,
      order
    );
  }

  const result = new Map();
  for (const [ym, m] of byMonth) {
    result.set(ym, finalizeMovement(m));
  }
  return result;
};

const reconcileMonthFromLoaded = (monthYm, tz, salesMovement, deliveries, returns, amendments) => {
  const netTpSales = salesMovement.netTpSales;

  let deliveredTp = 0;
  let returnedTp = 0;
  let amendedTp = 0;
  let excludedDeliveryTp = 0;
  let excludedReturnTp = 0;
  let excludedAmendmentTp = 0;
  const excludedOrderIds = new Set();

  for (const d of deliveries) {
    const order = d.orderId;
    if (!order) continue;
    const ym = businessTime.getBusinessMonthKey(d.deliveredAt, tz);
    if (ym !== monthYm) continue;
    const tp = grossTpForDelivery(d, order);
    if (isOrderFullyCredited(order)) {
      excludedOrderIds.add(String(order._id));
      excludedDeliveryTp += tp;
    } else {
      deliveredTp += tp;
    }
  }
  for (const ret of returns) {
    const order = ret.orderId;
    if (!order) continue;
    const ym = businessTime.getBusinessMonthKey(ret.returnedAt, tz);
    if (ym !== monthYm) continue;
    const tp = sumReturnTp(ret, order);
    if (isOrderFullyCredited(order)) {
      excludedOrderIds.add(String(order._id));
      excludedReturnTp += tp;
    } else {
      returnedTp += tp;
    }
  }
  for (const amd of amendments) {
    const order = amd.orderId;
    if (!order) continue;
    const ym = businessTime.getBusinessMonthKey(amd.amendedAt, tz);
    if (ym !== monthYm) continue;
    const tp = sumAmendmentTp(amd, order);
    if (isOrderFullyCredited(order)) {
      excludedOrderIds.add(String(order._id));
      excludedAmendmentTp += tp;
    } else {
      amendedTp += tp;
    }
  }

  const dashboardTp = roundPKR(deliveredTp - returnedTp - amendedTp);
  const difference = roundPKR(netTpSales - dashboardTp);
  excludedDeliveryTp = roundPKR(excludedDeliveryTp);
  excludedReturnTp = roundPKR(excludedReturnTp);
  excludedAmendmentTp = roundPKR(excludedAmendmentTp);
  const fullyCreditedImpact = roundPKR(excludedDeliveryTp - excludedReturnTp - excludedAmendmentTp);
  const unclassifiedTp = roundPKR(
    (salesMovement.returnsUnclassifiedTp || 0) + (salesMovement.amendmentsUnclassifiedTp || 0)
  );

  const reasons = [];
  if (Math.abs(fullyCreditedImpact) >= 0.01 || excludedOrderIds.size) {
    reasons.push({
      code: 'FULLY_CREDITED_ORDERS',
      label:
        'Dashboard TP excludes orders that are currently fully qty-credited (or status RETURNED). Transparent Net TP Sales includes all event-date legs.',
      tpImpact: fullyCreditedImpact,
      orderCount: excludedOrderIds.size
    });
  }
  if (unclassifiedTp >= 0.01) {
    reasons.push({
      code: 'LEGACY_UNCLASSIFIED',
      label:
        'Some return/amendment lines lack a source delivery period (run backfill:source-delivery). Still included in Net TP Sales; does not by itself explain Dashboard TP gap.',
      tpImpact: 0
    });
  }
  const explained = roundPKR(
    reasons
      .filter((r) => r.code !== 'LEGACY_UNCLASSIFIED')
      .reduce((s, r) => s + (r.tpImpact || 0), 0)
  );
  const residual = roundPKR(difference - explained);
  if (Math.abs(residual) >= 0.01) {
    reasons.push({
      code: 'OTHER',
      label: 'Residual difference after attributed reasons (rounding or data edge cases).',
      tpImpact: residual
    });
  }

  return {
    netTpSales,
    dashboardTp,
    difference,
    status: Math.abs(difference) < 0.01 ? 'MATCHED' : 'EXPLAINED_DIFFERENCE',
    reasons,
    fullyCredited: {
      orderCount: excludedOrderIds.size,
      excludedDeliveryTp,
      excludedReturnTp,
      excludedAmendmentTp,
      netExcludedImpact: fullyCreditedImpact
    }
  };
};

/**
 * Dashboard reconciliation for all fiscal months in one load (FY dateRange).
 */
const buildDashboardReconciliationsForMonths = async (
  companyId,
  dateRange,
  timeZone,
  monthKeys,
  salesMovementByMonth
) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const cid = objectId(companyId);
  const orderSelect = 'items status medicalRepId pharmacyId orderNumber';
  const [deliveries, returns, amendments] = await Promise.all([
    DeliveryRecord.find({ companyId: cid, isDeleted: nd, deliveredAt: dateRange })
      .populate({ path: 'orderId', select: orderSelect })
      .lean(),
    ReturnRecord.find({ companyId: cid, isDeleted: nd, returnedAt: dateRange })
      .populate({ path: 'orderId', select: orderSelect })
      .lean(),
    OrderAmendment.find({ companyId: cid, isDeleted: nd, amendedAt: dateRange })
      .populate({ path: 'orderId', select: orderSelect })
      .lean()
  ]);

  const result = new Map();
  for (const monthYm of monthKeys) {
    const salesMovement =
      salesMovementByMonth.get(monthYm) || finalizeMovement(emptyMovement());
    result.set(
      monthYm,
      reconcileMonthFromLoaded(monthYm, tz, salesMovement, deliveries, returns, amendments)
    );
  }
  return result;
};

/**
 * Dashboard reconciliation for one month: transparent Net TP Sales vs dashboard TP.
 */
const buildDashboardReconciliation = async (companyId, monthYm, timeZone, salesMovement) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const { DateTime } = require('luxon');
  const start = DateTime.fromFormat(monthYm, 'yyyy-MM', { zone: tz }).startOf('month');
  const dateRange = { $gte: start.toUTC().toJSDate(), $lte: start.endOf('month').toUTC().toJSDate() };
  const map = await buildDashboardReconciliationsForMonths(
    companyId,
    dateRange,
    tz,
    [monthYm],
    new Map([[monthYm, salesMovement]])
  );
  return map.get(monthYm);
};

const BUCKETS = new Set([
  'grossDeliveries',
  'returnsCurrentPeriod',
  'returnsPriorPeriod',
  'amendmentsCurrentPeriod',
  'amendmentsPriorPeriod',
  'netTpSales',
  'dashboardExclusion'
]);

const monthDateRange = (monthYm, tz) => {
  const { DateTime } = require('luxon');
  const z = businessTime.requireCompanyIanaZone(tz);
  const start = DateTime.fromFormat(monthYm, 'yyyy-MM', { zone: z }).startOf('month');
  if (!start.isValid) throw new ApiError(400, 'Invalid month — use YYYY-MM');
  return { $gte: start.toUTC().toJSDate(), $lte: start.endOf('month').toUTC().toJSDate() };
};

const lineClassification = (item, doc, eventYm, deliveryById, deliveriesByOrder, tz) => {
  const sourceYm = resolveSourceYmForLine(item, doc, deliveryById, deliveriesByOrder, eventYm, tz);
  return {
    sourceYm,
    classification: classifySourceDeliveryPeriod(eventYm, sourceYm),
    sourceDeliveredAt: item.sourceDeliveredAt || (sourceYm && deliveryById.get(String(item.sourceDeliveryId || item.deliveryId))?.deliveredAt) || null,
    sourceInvoiceNumber: item.sourceInvoiceNumber || ''
  };
};

const matchesBucket = (bucket, classification, eventType) => {
  if (bucket === 'netTpSales') return true;
  if (bucket === 'grossDeliveries') return eventType === 'DELIVERY';
  if (bucket === 'returnsCurrentPeriod') return eventType === 'RETURN' && classification === 'currentPeriod';
  if (bucket === 'returnsPriorPeriod') return eventType === 'RETURN' && classification === 'priorPeriod';
  if (bucket === 'amendmentsCurrentPeriod') return eventType === 'AMENDMENT' && classification === 'currentPeriod';
  if (bucket === 'amendmentsPriorPeriod') return eventType === 'AMENDMENT' && classification === 'priorPeriod';
  return false;
};

/**
 * Paginated drill-down of TP events for a month + bucket.
 */
const listTpEvents = async (companyId, query = {}, timeZone) => {
  const monthYm = qScalar(query.month);
  if (!monthYm || !/^\d{4}-\d{2}$/.test(monthYm)) {
    throw new ApiError(400, 'month is required (YYYY-MM)');
  }
  const bucket = qScalar(query.bucket) || 'netTpSales';
  if (!BUCKETS.has(bucket)) {
    throw new ApiError(400, `Invalid bucket: ${bucket}`);
  }

  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const cid = objectId(companyId);
  const dateRange = monthDateRange(monthYm, tz);
  const page = Math.max(1, parseInt(qScalar(query.page) || '1', 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(qScalar(query.limit) || '50', 10) || 50));

  const medicalRepId = qScalar(query.medicalRepId);
  const pharmacyId = qScalar(query.pharmacyId);
  const productId = qScalar(query.productId);
  const orderNumber = qScalar(query.orderNumber);
  const invoiceNumber = qScalar(query.invoiceNumber);
  const q = qScalar(query.q);
  const eventDateFrom = qScalar(query.eventDateFrom);
  const eventDateTo = qScalar(query.eventDateTo);

  const orderSelect = 'items status medicalRepId pharmacyId orderNumber distributorId';

  const [deliveries, returns, amendments] = await Promise.all([
    bucket === 'dashboardExclusion' || bucket === 'grossDeliveries' || bucket === 'netTpSales'
      ? DeliveryRecord.find({ companyId: cid, isDeleted: nd, deliveredAt: dateRange })
          .populate({ path: 'orderId', select: orderSelect })
          .lean()
      : Promise.resolve([]),
    bucket === 'dashboardExclusion' ||
    bucket === 'returnsCurrentPeriod' ||
    bucket === 'returnsPriorPeriod' ||
    bucket === 'netTpSales'
      ? ReturnRecord.find({ companyId: cid, isDeleted: nd, returnedAt: dateRange })
          .populate({ path: 'orderId', select: orderSelect })
          .lean()
      : Promise.resolve([]),
    bucket === 'dashboardExclusion' ||
    bucket === 'amendmentsCurrentPeriod' ||
    bucket === 'amendmentsPriorPeriod' ||
    bucket === 'netTpSales'
      ? OrderAmendment.find({ companyId: cid, isDeleted: nd, amendedAt: dateRange })
          .populate({ path: 'orderId', select: orderSelect })
          .lean()
      : Promise.resolve([])
  ]);

  const orderIds = [
    ...new Set([
      ...returns.map((r) => String(r.orderId?._id || r.orderId)).filter(Boolean),
      ...amendments.map((a) => String(a.orderId?._id || a.orderId)).filter(Boolean),
      ...deliveries.map((d) => String(d.orderId?._id || d.orderId)).filter(Boolean)
    ])
  ].map(objectId);
  const { deliveryById, deliveriesByOrder } = await loadDeliveryLookups(cid, orderIds);

  /** @type {any[]} */
  let rows = [];

  if (bucket === 'dashboardExclusion') {
    const pushIfExcluded = (eventType, eventAt, eventId, order, tpAmount, packs, invoice, customerNet, extra = {}) => {
      if (!order || !isOrderFullyCredited(order)) return;
      rows.push({
        eventType,
        eventId: String(eventId),
        eventAt,
        eventYm: monthYm,
        orderId: String(order._id),
        orderNumber: order.orderNumber || '',
        invoiceNumber: invoice || '',
        orderStatus: order.status,
        medicalRepId: order.medicalRepId ? String(order.medicalRepId) : null,
        pharmacyId: order.pharmacyId ? String(order.pharmacyId) : null,
        sourceDeliveredAt: extra.sourceDeliveredAt || null,
        sourceDeliveryYm: extra.sourceDeliveryYm || null,
        classification: 'dashboardExclusion',
        packs: packs || 0,
        productIds: extra.productIds || [],
        productsLabel: extra.productsLabel || '',
        tpAmount: roundPKR(tpAmount),
        customerNet: roundPKR(customerNet || 0),
        companyShare: roundPKR(extra.companyShare || 0)
      });
    };

    for (const d of deliveries) {
      const order = d.orderId;
      if (!order) continue;
      const packs = (d.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0);
      pushIfExcluded(
        'DELIVERY',
        d.deliveredAt,
        d._id,
        order,
        grossTpForDelivery(d, order),
        packs,
        d.invoiceNumber,
        d.pharmacyNetPayable ?? d.totalAmount,
        {
          sourceDeliveredAt: d.deliveredAt,
          sourceDeliveryYm: monthYm,
          productIds: (d.items || []).map((i) => String(i.productId)),
          companyShare: d.companyShareTotal
        }
      );
    }
    for (const ret of returns) {
      const order = ret.orderId;
      if (!order) continue;
      const packs = (ret.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0);
      pushIfExcluded(
        'RETURN',
        ret.returnedAt,
        ret._id,
        order,
        sumReturnTp(ret, order),
        packs,
        ret.items?.[0]?.sourceInvoiceNumber || '',
        ret.totalAmount,
        {
          productIds: (ret.items || []).map((i) => String(i.productId)),
          companyShare: (ret.items || []).reduce((s, i) => s + (Number(i.companyShare) || 0), 0)
        }
      );
    }
    for (const amd of amendments) {
      const order = amd.orderId;
      if (!order) continue;
      const packs = (amd.items || []).reduce((s, i) => s + (Number(i.deltaQty) || 0), 0);
      pushIfExcluded(
        'AMENDMENT',
        amd.amendedAt,
        amd._id,
        order,
        sumAmendmentTp(amd, order),
        packs,
        (amd.invoiceNumbers || [])[0] || amd.items?.[0]?.sourceInvoiceNumber || '',
        amd.totalAmount,
        {
          productIds: (amd.items || []).map((i) => String(i.productId)),
          companyShare: (amd.items || []).reduce((s, i) => s + (Number(i.companyShare) || 0), 0)
        }
      );
    }
  } else {
    if (bucket === 'grossDeliveries' || bucket === 'netTpSales') {
      for (const d of deliveries) {
        const order = d.orderId;
        if (!order || isOrderFullyCredited(order)) continue;
        const tp = grossTpForDelivery(d, order);
        const packs = (d.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0);
        rows.push({
          eventType: 'DELIVERY',
          eventId: String(d._id),
          eventAt: d.deliveredAt,
          eventYm: monthYm,
          orderId: String(order._id),
          orderNumber: order.orderNumber || '',
          invoiceNumber: d.invoiceNumber || '',
          orderStatus: order.status,
          medicalRepId: order.medicalRepId ? String(order.medicalRepId) : null,
          pharmacyId: order.pharmacyId ? String(order.pharmacyId) : null,
          sourceDeliveredAt: d.deliveredAt,
          sourceDeliveryYm: monthYm,
          classification: 'currentPeriod',
          packs,
          productIds: (d.items || []).map((i) => String(i.productId)),
          productsLabel: '',
          tpAmount: tp,
          customerNet: roundPKR(d.pharmacyNetPayable ?? d.totalAmount ?? 0),
          companyShare: roundPKR(d.companyShareTotal ?? 0)
        });
      }
    }

    if (
      bucket === 'returnsCurrentPeriod' ||
      bucket === 'returnsPriorPeriod' ||
      bucket === 'netTpSales'
    ) {
      for (const ret of returns) {
        const order = ret.orderId;
        if (!order || isOrderFullyCredited(order)) continue;
        const docTp = sumReturnTp(ret, order);
        const tmp = emptyMovement();
        allocateDebitBySourcePeriod(
          tmp,
          'returns',
          docTp,
          ret.items,
          ret,
          monthYm,
          deliveryById,
          deliveriesByOrder,
          tz,
          returnLineTp,
          order
        );
        let packs = 0;
        let companyShare = 0;
        let sourceDeliveredAt = null;
        let sourceDeliveryYm = null;
        let invoice = '';
        const productIds = [];
        for (const item of ret.items || []) {
          const meta = lineClassification(item, ret, monthYm, deliveryById, deliveriesByOrder, tz);
          packs += Number(item.quantity) || 0;
          companyShare += Number(item.companyShare) || 0;
          productIds.push(String(item.productId));
          if (!sourceDeliveredAt && meta.sourceDeliveredAt) sourceDeliveredAt = meta.sourceDeliveredAt;
          if (!sourceDeliveryYm && meta.sourceYm) sourceDeliveryYm = meta.sourceYm;
          if (!invoice && item.sourceInvoiceNumber) invoice = item.sourceInvoiceNumber;
        }
        const parts = [
          { classification: 'currentPeriod', tp: tmp.returnsCurrentPeriodTp },
          { classification: 'priorPeriod', tp: tmp.returnsPriorPeriodTp },
          { classification: 'unclassified', tp: tmp.returnsUnclassifiedTp }
        ].filter((p) => p.tp > 0);

        for (const part of parts) {
          if (bucket !== 'netTpSales' && !matchesBucket(bucket, part.classification, 'RETURN')) continue;
          rows.push({
            eventType: 'RETURN',
            eventId: String(ret._id),
            eventAt: ret.returnedAt,
            eventYm: monthYm,
            orderId: String(order._id),
            orderNumber: order.orderNumber || '',
            invoiceNumber: invoice,
            orderStatus: order.status,
            medicalRepId: order.medicalRepId ? String(order.medicalRepId) : null,
            pharmacyId: order.pharmacyId ? String(order.pharmacyId) : null,
            sourceDeliveredAt,
            sourceDeliveryYm,
            classification: part.classification,
            packs,
            productIds,
            productsLabel: '',
            tpAmount: roundPKR(part.tp),
            customerNet: roundPKR(ret.totalAmount || 0),
            companyShare: roundPKR(companyShare)
          });
        }
      }
    }

    if (
      bucket === 'amendmentsCurrentPeriod' ||
      bucket === 'amendmentsPriorPeriod' ||
      bucket === 'netTpSales'
    ) {
      for (const amd of amendments) {
        const order = amd.orderId;
        if (!order || isOrderFullyCredited(order)) continue;
        const docTp = sumAmendmentTp(amd, order);
        const tmp = emptyMovement();
        allocateDebitBySourcePeriod(
          tmp,
          'amendments',
          docTp,
          amd.items,
          amd,
          monthYm,
          deliveryById,
          deliveriesByOrder,
          tz,
          amendmentLineTp,
          order
        );
        let packs = 0;
        let companyShare = 0;
        let sourceDeliveredAt = null;
        let sourceDeliveryYm = null;
        const productIds = [];
        for (const item of amd.items || []) {
          const meta = lineClassification(item, amd, monthYm, deliveryById, deliveriesByOrder, tz);
          packs += Number(item.deltaQty) || 0;
          companyShare += Number(item.companyShare) || 0;
          productIds.push(String(item.productId));
          if (!sourceDeliveredAt && meta.sourceDeliveredAt) sourceDeliveredAt = meta.sourceDeliveredAt;
          if (!sourceDeliveryYm && meta.sourceYm) sourceDeliveryYm = meta.sourceYm;
        }
        const parts = [
          { classification: 'currentPeriod', tp: tmp.amendmentsCurrentPeriodTp },
          { classification: 'priorPeriod', tp: tmp.amendmentsPriorPeriodTp },
          { classification: 'unclassified', tp: tmp.amendmentsUnclassifiedTp }
        ].filter((p) => p.tp > 0);

        for (const part of parts) {
          if (bucket !== 'netTpSales' && !matchesBucket(bucket, part.classification, 'AMENDMENT')) {
            continue;
          }
          rows.push({
            eventType: 'AMENDMENT',
            eventId: String(amd._id),
            eventAt: amd.amendedAt,
            eventYm: monthYm,
            orderId: String(order._id),
            orderNumber: order.orderNumber || '',
            invoiceNumber: (amd.invoiceNumbers || [])[0] || '',
            orderStatus: order.status,
            medicalRepId: order.medicalRepId ? String(order.medicalRepId) : null,
            pharmacyId: order.pharmacyId ? String(order.pharmacyId) : null,
            sourceDeliveredAt,
            sourceDeliveryYm,
            classification: part.classification,
            packs,
            productIds,
            productsLabel: '',
            tpAmount: roundPKR(part.tp),
            customerNet: roundPKR(amd.totalAmount || 0),
            companyShare: roundPKR(companyShare),
            amendmentNumber: amd.amendmentNumber || ''
          });
        }
      }
    }
  }

  // Filters
  if (medicalRepId) {
    rows = rows.filter((r) => r.medicalRepId === medicalRepId);
  }
  if (pharmacyId) {
    rows = rows.filter((r) => r.pharmacyId === pharmacyId);
  }
  if (productId) {
    rows = rows.filter((r) => (r.productIds || []).includes(productId));
  }
  if (orderNumber) {
    const re = new RegExp(escapeRegex(orderNumber), 'i');
    rows = rows.filter((r) => re.test(r.orderNumber || ''));
  }
  if (invoiceNumber) {
    const re = new RegExp(escapeRegex(invoiceNumber), 'i');
    rows = rows.filter((r) => re.test(r.invoiceNumber || ''));
  }
  if (eventDateFrom || eventDateTo) {
    const lo = eventDateFrom
      ? businessTime.filterLowerBoundUtc(eventDateFrom, tz)
      : null;
    const hi = eventDateTo ? businessTime.filterUpperBoundUtc(eventDateTo, tz) : null;
    rows = rows.filter((r) => {
      const t = new Date(r.eventAt).getTime();
      if (lo && t < lo.getTime()) return false;
      if (hi && t > hi.getTime()) return false;
      return true;
    });
  }

  // Enrich names for search + display
  const pharmacyIds = [...new Set(rows.map((r) => r.pharmacyId).filter(Boolean))];
  const repIds = [...new Set(rows.map((r) => r.medicalRepId).filter(Boolean))];
  const allProductIds = [...new Set(rows.flatMap((r) => r.productIds || []))];

  const [pharmacies, reps, products] = await Promise.all([
    pharmacyIds.length
      ? Pharmacy.find({ _id: { $in: pharmacyIds.map(objectId) } }).select('name').lean()
      : [],
    repIds.length ? User.find({ _id: { $in: repIds.map(objectId) } }).select('name').lean() : [],
    allProductIds.length
      ? Product.find({ _id: { $in: allProductIds.map(objectId) } }).select('name').lean()
      : []
  ]);
  const pharmacyName = new Map(pharmacies.map((p) => [String(p._id), p.name]));
  const repName = new Map(reps.map((u) => [String(u._id), u.name]));
  const productName = new Map(products.map((p) => [String(p._id), p.name]));

  for (const r of rows) {
    r.pharmacyName = r.pharmacyId ? pharmacyName.get(r.pharmacyId) || '' : '';
    r.medicalRepName = r.medicalRepId ? repName.get(r.medicalRepId) || '' : '';
    const names = (r.productIds || []).map((id) => productName.get(id) || 'Product').filter(Boolean);
    r.productCount = names.length;
    r.productsLabel =
      names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
  }

  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    rows = rows.filter(
      (r) =>
        re.test(r.orderNumber || '') ||
        re.test(r.invoiceNumber || '') ||
        re.test(r.pharmacyName || '') ||
        re.test(r.medicalRepName || '') ||
        re.test(r.productsLabel || '') ||
        re.test(r.amendmentNumber || '')
    );
  }

  rows.sort((a, b) => new Date(b.eventAt) - new Date(a.eventAt));

  const signedImpact = (r) => {
    const mag = Math.abs(Number(r.tpAmount) || 0);
    if (bucket === 'netTpSales' && (r.eventType === 'RETURN' || r.eventType === 'AMENDMENT')) {
      return -mag;
    }
    return mag;
  };

  const totalTp = roundPKR(rows.reduce((s, r) => s + signedImpact(r), 0));
  const orderCount = new Set(rows.map((r) => r.orderId)).size;
  const invoiceCount = new Set(rows.map((r) => r.invoiceNumber).filter(Boolean)).size;
  const packCount = rows.reduce((s, r) => s + (Number(r.packs) || 0), 0);
  const productCount = new Set(rows.flatMap((r) => r.productIds || [])).size;

  const totalCount = rows.length;
  const start = (page - 1) * limit;
  const pageRows = rows.slice(start, start + limit).map((r) => ({
    eventType: r.eventType,
    eventId: r.eventId,
    eventAt: r.eventAt,
    eventYm: r.eventYm,
    orderId: r.orderId,
    orderNumber: r.orderNumber,
    invoiceNumber: r.invoiceNumber,
    orderStatus: r.orderStatus,
    medicalRepId: r.medicalRepId,
    medicalRepName: r.medicalRepName,
    pharmacyId: r.pharmacyId,
    pharmacyName: r.pharmacyName,
    sourceDeliveredAt: r.sourceDeliveredAt,
    sourceDeliveryYm: r.sourceDeliveryYm,
    classification: r.classification,
    packs: r.packs,
    productCount: r.productCount,
    productsLabel: r.productsLabel,
    tpAmount: roundPKR(signedImpact(r)),
    customerNet: r.customerNet,
    companyShare: r.companyShare,
    amendmentNumber: r.amendmentNumber || undefined
  }));

  const { DateTime } = require('luxon');
  const monthLabel = DateTime.fromFormat(monthYm, 'yyyy-MM', { zone: tz }).toFormat('MMMM yyyy');

  return {
    month: monthYm,
    monthLabel,
    bucket,
    summary: {
      totalTp,
      orderCount,
      invoiceCount,
      packCount,
      productCount
    },
    filtersApplied: {
      medicalRepId: medicalRepId || null,
      pharmacyId: pharmacyId || null,
      productId: productId || null,
      orderNumber: orderNumber || null,
      invoiceNumber: invoiceNumber || null,
      eventDateFrom: eventDateFrom || null,
      eventDateTo: eventDateTo || null,
      q: q || null
    },
    rows: pageRows,
    page,
    limit,
    totalCount,
    totals: { tpAmount: totalTp }
  };
};

module.exports = {
  emptyMovement,
  finalizeMovement,
  aggregateSalesMovementByMonth,
  buildDashboardReconciliation,
  buildDashboardReconciliationsForMonths,
  listTpEvents,
  returnLineTp,
  amendmentLineTp
};
