/**
 * Backfill source-delivery snapshot fields on ReturnRecord / OrderAmendment lines.
 *
 * Dry-run (default):
 *   node scripts/backfillReturnAmendmentSourceDelivery.js
 *
 * Apply:
 *   node scripts/backfillReturnAmendmentSourceDelivery.js --apply
 *
 * Optional:
 *   --company=<id>
 *
 * Env: MONGODB_URI
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');
const Order = require('../src/models/Order');
const DeliveryRecord = require('../src/models/DeliveryRecord');
const ReturnRecord = require('../src/models/ReturnRecord');
const OrderAmendment = require('../src/models/OrderAmendment');
const { requireCompanyIanaZone } = require('../src/utils/businessTime');
const { roundPKR } = require('../src/utils/currency');
const { buildSourceDeliverySnapshot } = require('../src/utils/sourceDeliverySnapshot.util');

const nd = { $ne: true };
const apply = process.argv.includes('--apply');
const companyArg = process.argv.find((a) => a.startsWith('--company='));
const companyFilterId = companyArg ? companyArg.split('=')[1] : null;

const latestDeliveryForProduct = (deliveries, productId) => {
  const pid = String(productId);
  let best = null;
  for (const d of deliveries) {
    const has = (d.items || []).some((i) => String(i.productId) === pid);
    if (!has) continue;
    if (!best || new Date(d.deliveredAt) > new Date(best.deliveredAt)) best = d;
  }
  return best;
};

const resolveDelivery = (item, doc, deliveriesById, deliveriesForOrder) => {
  const id =
    item.sourceDeliveryId ||
    item.deliveryId ||
    (doc.allocations || []).find((a) => a.deliveryId)?.deliveryId ||
    null;
  if (id && deliveriesById.has(String(id))) return deliveriesById.get(String(id));
  return latestDeliveryForProduct(deliveriesForOrder, item.productId);
};

const lineNeedsBackfill = (item, isReturn) => {
  if (!item.sourceDeliveryId || !item.sourceDeliveryYm || !item.sourceDeliveredAt) return true;
  if (isReturn && (item.tpAmount == null || item.tpAmount === undefined)) return true;
  return false;
};

const run = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    process.stderr.write('MONGODB_URI is required\n');
    process.exit(1);
  }
  await mongoose.connect(uri);

  const companyQuery = { isDeleted: nd };
  if (companyFilterId) companyQuery._id = companyFilterId;
  const companies = await Company.find(companyQuery).select('name timeZone').lean();
  const companyById = new Map(companies.map((c) => [String(c._id), c]));

  let returnsUpdated = 0;
  let amendsUpdated = 0;
  let returnLines = 0;
  let amendLines = 0;
  let skippedNoTz = 0;

  const baseFilter = { isDeleted: nd };
  if (companyFilterId) baseFilter.companyId = companyFilterId;

  const returns = await ReturnRecord.find(baseFilter).lean();
  for (const ret of returns) {
    const company = companyById.get(String(ret.companyId));
    if (!company?.timeZone) {
      skippedNoTz += 1;
      continue;
    }
    let tz;
    try {
      tz = requireCompanyIanaZone(company.timeZone);
    } catch {
      skippedNoTz += 1;
      continue;
    }

    const needs = (ret.items || []).some((i) => lineNeedsBackfill(i, true));
    if (!needs) continue;

    const order = await Order.findById(ret.orderId).select('items').lean();
    const deliveries = await DeliveryRecord.find({
      companyId: ret.companyId,
      orderId: ret.orderId,
      isDeleted: nd
    })
      .sort({ deliveredAt: -1 })
      .lean();
    const deliveriesById = new Map(deliveries.map((d) => [String(d._id), d]));

    const nextItems = (ret.items || []).map((item) => {
      if (!lineNeedsBackfill(item, true)) return item;
      const delivery = resolveDelivery(item, ret, deliveriesById, deliveries);
      const snap = buildSourceDeliverySnapshot(delivery, tz);
      const oi = order?.items?.find((i) => String(i.productId) === String(item.productId));
      const tpAmount =
        item.tpAmount != null
          ? item.tpAmount
          : roundPKR((oi?.tpAtTime || 0) * (Number(item.quantity) || 0));
      returnLines += 1;
      return { ...item, ...snap, tpAmount };
    });

    returnsUpdated += 1;
    if (apply) {
      await ReturnRecord.updateOne({ _id: ret._id }, { $set: { items: nextItems } });
    }
  }

  const amends = await OrderAmendment.find(baseFilter).lean();
  for (const amd of amends) {
    const company = companyById.get(String(amd.companyId));
    if (!company?.timeZone) {
      skippedNoTz += 1;
      continue;
    }
    let tz;
    try {
      tz = requireCompanyIanaZone(company.timeZone);
    } catch {
      skippedNoTz += 1;
      continue;
    }

    const needs = (amd.items || []).some((i) => lineNeedsBackfill(i, false));
    if (!needs) continue;

    const deliveries = await DeliveryRecord.find({
      companyId: amd.companyId,
      orderId: amd.orderId,
      isDeleted: nd
    })
      .sort({ deliveredAt: -1 })
      .lean();
    const deliveriesById = new Map(deliveries.map((d) => [String(d._id), d]));

    const nextItems = (amd.items || []).map((item) => {
      if (!lineNeedsBackfill(item, false)) return item;
      const delivery = resolveDelivery(item, amd, deliveriesById, deliveries);
      const snap = buildSourceDeliverySnapshot(delivery, tz);
      amendLines += 1;
      return {
        ...item,
        ...snap,
        deliveryId: item.deliveryId || snap.sourceDeliveryId || null,
        sourceDeliveryId: snap.sourceDeliveryId || item.deliveryId || null
      };
    });

    amendsUpdated += 1;
    if (apply) {
      await OrderAmendment.updateOne({ _id: amd._id }, { $set: { items: nextItems } });
    }
  }

  process.stdout.write(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        returnsUpdated,
        returnLinesTouched: returnLines,
        amendmentsUpdated: amendsUpdated,
        amendmentLinesTouched: amendLines,
        skippedNoTz,
        note: apply ? 'Updates written' : 'No writes; re-run with --apply'
      },
      null,
      2
    ) + '\n'
  );

  await mongoose.disconnect();
};

run().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
